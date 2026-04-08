import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';
import YahooFinance from 'yahoo-finance2'; // 🛡️ Importação correta

// 🔑 A CHAVE DE IGNIÇÃO 
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const app = express();
app.use(cors());
app.use(express.json()); 

// 1. CONFIGURAÇÃO DA INTELIGÊNCIA ARTIFICIAL (GEMINI)
const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);
const modeloIA = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

const ARQUIVO_CACHE = './banco_de_dados.json';
let cacheMemoria = { cotacoes: {}, historico: {} };

if (fs.existsSync(ARQUIVO_CACHE)) {
    try {
        const dadosSalvos = fs.readFileSync(ARQUIVO_CACHE, 'utf8');
        cacheMemoria = JSON.parse(dadosSalvos);
        console.log("💾 Banco de dados local recuperado com sucesso!");
    } catch (e) { console.error("Erro ao ler banco local."); }
}

function salvarNoDisco() {
    try { fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify(cacheMemoria), 'utf8'); } 
    catch (e) { console.error("Erro ao salvar no disco."); }
}

function calcularDataInicio(range) {
    const data = new Date();
    if (range === '1mo') data.setMonth(data.getMonth() - 1);
    else if (range === '6mo') data.setMonth(data.getMonth() - 6);
    else if (range === '1y') data.setFullYear(data.getFullYear() - 1);
    else if (range === '5y') data.setFullYear(data.getFullYear() - 5);
    else data.setMonth(data.getMonth() - 1); 
    return data.toISOString().split('T')[0]; 
}

// ROTA 1: Cotações em Lote 
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    const tickersParaAtualizar = tickers.filter(t => !cacheMemoria.cotacoes[t] || (agora - cacheMemoria.cotacoes[t].timestamp >= 300000));

    if (tickersParaAtualizar.length > 0) {
        try {
            const resultadosApi = await yahooFinance.quote(tickersParaAtualizar);
            const resultadosArray = Array.isArray(resultadosApi) ? resultadosApi : [resultadosApi];

            resultadosArray.forEach(item => {
                if (item && item.symbol) {
                    cacheMemoria.cotacoes[item.symbol] = {
                        timestamp: agora,
                        dados: {
                            ticker: item.symbol,
                            atual: item.regularMarketPrice,
                            fechamentoAnterior: item.regularMarketPreviousClose || item.regularMarketPrice
                        }
                    };
                }
            });
            salvarNoDisco();
        } catch (e) { console.log(`❌ Erro na busca em lote: ${e.message}`); }
    }

    const respostaFinal = {};
    tickers.forEach(t => { if (cacheMemoria.cotacoes[t]) respostaFinal[t] = cacheMemoria.cotacoes[t].dados; });
    res.json(respostaFinal);
});

// ROTA 2: Histórico para Gráficos
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const chave = `${ticker}-${range}`; 
    const agora = Date.now();

    if (cacheMemoria.historico[chave] && (agora - cacheMemoria.historico[chave].timestamp < 3600000)) {
        return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
    }

    try {
        const period1 = calcularDataInicio(range); 
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close)).map(q => ({ time: q.date.toISOString().split('T')[0], close: parseFloat(q.close) }));
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        return res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro ao buscar histórico.`}); 
    }
});

// ROTA 3: ANÁLISE TÉCNICA ON-DEMAND (IA)
app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    try {
        const period1 = calcularDataInicio('6mo'); 
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: '1d' });
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close));
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => `${q.date.toISOString().split('T')[0]}: ${q.close.toFixed(2)}`).join(', ');

        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), o SUPORTE mais relevante e a RESISTÊNCIA. 
        Retorne APENAS JSON: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        const resultado = await modeloIA.generateContent(prompt);
        res.json(JSON.parse(resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim()));
    } catch (erro) { res.status(500).json({ erro: "Erro na IA." }); }
});

// 🚀 NOVA ROTA 4: RADAR CORPORATIVO E DE FUNDAMENTOS (RI) DA IA
app.get('/api/analise-ri/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    console.log(`💼 [IA] Lendo Balanço Corporativo (RI) para: ${ticker}`);

    try {
        // 1. Extrai a "Matemática Fria" do Balanço
        const resultYahoo = await yahooFinance.quoteSummary(ticker, { 
            modules: ['financialData', 'defaultKeyStatistics'] 
        });

        const fin = resultYahoo.financialData || {};
        
        const formataDinheiro = (val) => val ? (val / 1000000).toFixed(2) + ' Milhões' : 'N/A';

        const dossie = `
        DADOS OFICIAIS DO ÚLTIMO BALANÇO:
        Receita Total: ${formataDinheiro(fin.totalRevenue)}
        EBITDA: ${formataDinheiro(fin.ebitda)}
        Lucro/Prejuízo: ${formataDinheiro(fin.netIncomeToCommon)}
        Caixa Total: ${formataDinheiro(fin.totalCash)}
        Dívida Total: ${formataDinheiro(fin.totalDebt)}
        Livre Geração de Caixa (FCF): ${formataDinheiro(fin.freeCashflow)}
        Margem Líquida: ${fin.profitMargins ? (fin.profitMargins * 100).toFixed(2) + '%' : 'N/A'}
        ROE: ${fin.returnOnEquity ? (fin.returnOnEquity * 100).toFixed(2) + '%' : 'N/A'}
        Crescimento Trimestral da Receita: ${fin.revenueGrowth ? (fin.revenueGrowth * 100).toFixed(2) + '%' : 'N/A'}
        Crescimento Trimestral do Lucro: ${fin.earningsGrowth ? (fin.earningsGrowth * 100).toFixed(2) + '%' : 'N/A'}
        `;

        // 2. Novo Prompt: Postura de Auditor Contábil
        const prompt = `Você é um Auditor Contábil e Analista Fundamentalista Sênior. 
        Sua tarefa é ler EXCLUSIVAMENTE os números oficiais do último balanço da empresa ${ticker} listados abaixo:
        
        ${dossie}

        REGRA DE OURO: É estritamente PROIBIDO mencionar notícias de juros, macroeconomia, fofocas de mercado ou contexto político. Baseie sua resposta APENAS na matemática apresentada acima.

        Faça uma leitura técnica contábil apontando:
        - Os 3 principais PRÓS FINANCEIROS (Ex: Margens altas, crescimento forte da receita/lucro, caixa livre positivo).
        - Os 3 principais CONTRAS FINANCEIROS (Ex: Alavancagem pesada, queda no lucro, queima de caixa livre).

        Retorne APENAS um JSON estrito no formato:
        {
          "ticker": "${ticker}",
          "pros": ["Pro contábil 1", "Pro contábil 2", "Pro contábil 3"],
          "contras": ["Contra de risco 1", "Contra de risco 2", "Contra de risco 3"]
        }`;

        // 3. IA mastiga e devolve o JSON limpo
        const resultado = await modeloIA.generateContent(prompt);
        const jsonLimpo = resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim();
        
        res.json(JSON.parse(jsonLimpo));

    } catch (erro) {
        console.error("❌ Erro no Leitor de RI:", erro.message);
        res.status(500).json({ erro: "Não foi possível gerar o radar agora." });
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));