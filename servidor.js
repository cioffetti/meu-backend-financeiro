import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';
import YahooFinance from 'yahoo-finance2'; 

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const app = express();
app.use(cors());
app.use(express.json()); 

// 1. CONFIGURAÇÃO DA IA
const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);
const modeloIA = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

const ARQUIVO_CACHE = './banco_de_dados.json';
let cacheMemoria = { cotacoes: {}, historico: {} };

// 🛡️ COFRE DE SOBREVIVÊNCIA (Lê os dados do robô da madrugada)
let dbEstatico = {};
try {
    if (fs.existsSync('./indicadores.json')) {
        dbEstatico = JSON.parse(fs.readFileSync('./indicadores.json', 'utf8'));
        console.log("📦 Cofre Estático (indicadores.json) carregado para emergências!");
    }
} catch (e) { console.log("Aviso: indicadores.json não encontrado."); }

if (fs.existsSync(ARQUIVO_CACHE)) {
    try { cacheMemoria = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8')); } catch (e) { }
}

function salvarNoDisco() {
    try { fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify(cacheMemoria), 'utf8'); } catch (e) { }
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

// 🛡️ MOTOR BLINDADO DE GRÁFICOS (Ignora o Erro 429)
async function buscarHistoricoRobusto(ticker, range, interval) {
    try {
        // Tentativa 1: Oficial
        const period1 = calcularDataInicio(range);
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        return result.quotes.filter(q => q.close !== null && !isNaN(q.close)).map(q => ({ time: q.date.toISOString().split('T')[0], close: parseFloat(q.close) }));
    } catch (e) {
        console.log(`⚠️ Bloqueio 429 detectado no gráfico de ${ticker}. Ativando Proxies...`);
        // Tentativa 2: Proxies (Passa por baixo da porta do Yahoo)
        const targetUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
        const proxies = [
            targetUrl, // Tenta o fetch direto sem crumbs
            `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
        ];
        
        for (let url of proxies) {
            try {
                const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (!resposta.ok) continue;
                const dados = await resposta.json();
                const quotes = dados.chart.result[0].indicators.quote[0];
                const timestamps = dados.chart.result[0].timestamp;
                return timestamps.map((t, i) => ({ time: new Date(t * 1000).toISOString().split('T')[0], close: parseFloat(quotes.close[i]) })).filter(q => !isNaN(q.close));
            } catch (err) {}
        }
        throw new Error("Falha total nos proxies.");
    }
}

// ROTA 1: Cotações em Lote (Com Fallback Estático)
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
                    cacheMemoria.cotacoes[item.symbol] = { timestamp: agora, dados: { ticker: item.symbol, atual: item.regularMarketPrice, fechamentoAnterior: item.regularMarketPreviousClose || item.regularMarketPrice } };
                }
            });
            salvarNoDisco();
        } catch (e) { 
            console.log(`⚠️ Bloqueio 429 nas cotações. Usando o Cofre Estático...`);
            tickersParaAtualizar.forEach(t => {
                if(dbEstatico[t] && dbEstatico[t].precoAtual) {
                    cacheMemoria.cotacoes[t] = { timestamp: agora, dados: { ticker: t, atual: dbEstatico[t].precoAtual, fechamentoAnterior: dbEstatico[t].precoAtual } };
                }
            });
        }
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
        const processados = await buscarHistoricoRobusto(ticker, range, interval);
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
        const processados = await buscarHistoricoRobusto(ticker, '6mo', '1d');
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => `${q.time}: ${q.close.toFixed(2)}`).join(', ');

        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), o SUPORTE mais relevante e a RESISTÊNCIA. 
        Retorne APENAS JSON: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        const resultado = await modeloIA.generateContent(prompt);
        res.json(JSON.parse(resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim()));
    } catch (erro) { res.status(500).json({ erro: "Erro na IA ou Yahoo bloqueado." }); }
});

// ROTA 4: RADAR CORPORATIVO E DE FUNDAMENTOS (RI) DA IA
app.get('/api/analise-ri/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    console.log(`💼 [IA] Lendo Balanço Corporativo (RI) para: ${ticker}`);

    try {
        let dossie = "";
        const formataDinheiro = (val) => val ? (val / 1000000).toFixed(2) + ' Milhões' : 'N/A';

        try {
            // Tentativa Oficial
            const resultYahoo = await yahooFinance.quoteSummary(ticker, { modules: ['financialData'] });
            const fin = resultYahoo.financialData || {};
            dossie = `
            Receita Total: ${formataDinheiro(fin.totalRevenue)} | EBITDA: ${formataDinheiro(fin.ebitda)} | Caixa Total: ${formataDinheiro(fin.totalCash)}
            Dívida Total: ${formataDinheiro(fin.totalDebt)} | Margem Líquida: ${fin.profitMargins ? (fin.profitMargins * 100).toFixed(2) + '%' : 'N/A'}
            Crescimento Trimestral da Receita: ${fin.revenueGrowth ? (fin.revenueGrowth * 100).toFixed(2) + '%' : 'N/A'}
            `;
        } catch(e) {
            // Bloqueio 429? Pega a matemática fria do seu banco de dados interno!
            console.log(`⚠️ Bloqueio 429 no RI. Lendo fundamentos do Cofre (indicadores.json)...`);
            if(!dbEstatico[ticker]) throw new Error("Sem dados no cofre");
            const d = dbEstatico[ticker];
            dossie = `
            P/L: ${d.pl || 'N/A'} | P/VP: ${d.pvp || 'N/A'} | EV/EBITDA: ${d.evEbitda || 'N/A'}
            Margem Líquida: ${d.margemLiquida ? (d.margemLiquida * 100).toFixed(2) + '%' : 'N/A'}
            ROE: ${d.roe ? (d.roe * 100).toFixed(2) + '%' : 'N/A'} | Dívida/PL: ${d.dividaPL || 'N/A'}
            `;
        }

        const prompt = `Você é um Auditor Contábil e Analista Fundamentalista Sênior. 
        Sua tarefa é ler EXCLUSIVAMENTE os números corporativos da empresa ${ticker} listados abaixo:
        [${dossie}]

        REGRA DE OURO: É estritamente PROIBIDO mencionar fofocas de mercado. Baseie sua resposta APENAS na matemática apresentada acima.

        Faça uma leitura técnica contábil apontando:
        - Os 3 principais PRÓS FINANCEIROS.
        - Os 3 principais CONTRAS FINANCEIROS.

        Retorne APENAS um JSON estrito no formato:
        { "ticker": "${ticker}", "pros": ["Pro 1", "Pro 2", "Pro 3"], "contras": ["Contra 1", "Contra 2", "Contra 3"] }`;

        const resultado = await modeloIA.generateContent(prompt);
        const jsonLimpo = resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim();
        res.json(JSON.parse(jsonLimpo));

    } catch (erro) {
        console.error("❌ Erro no Leitor de RI:", erro.message);
        res.status(500).json({ erro: "Não foi possível processar os dados corporativos agora." });
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));