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

// ⏳ TRADUTOR DE TEMPO PARA O YAHOO V3
function calcularDataInicio(range) {
    const data = new Date();
    if (range === '1mo') data.setMonth(data.getMonth() - 1);
    else if (range === '6mo') data.setMonth(data.getMonth() - 6);
    else if (range === '1y') data.setFullYear(data.getFullYear() - 1);
    else if (range === '5y') data.setFullYear(data.getFullYear() - 5);
    else data.setMonth(data.getMonth() - 1); // fallback de 1 mês
    return data.toISOString().split('T')[0]; // Retorna YYYY-MM-DD
}

// ROTA 1: Cotações em Lote 
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    const fetchTicker = async (t) => {
        if (cacheMemoria.cotacoes[t] && (agora - cacheMemoria.cotacoes[t].timestamp < 300000)) return cacheMemoria.cotacoes[t].dados;
        try {
            const result = await yahooFinance.quote(t);
            const resultado = { 
                ticker: t, 
                atual: result.regularMarketPrice, 
                fechamentoAnterior: result.regularMarketPreviousClose || result.regularMarketPrice 
            };
            cacheMemoria.cotacoes[t] = { timestamp: agora, dados: resultado };
            return resultado;
        } catch (e) { 
            console.log(`Aviso: Cotação falhou para ${t}`);
            return cacheMemoria.cotacoes[t] ? cacheMemoria.cotacoes[t].dados : null; 
        }
    };

    const results = await Promise.all(tickers.map(t => fetchTicker(t)));
    salvarNoDisco(); 
    const respostaFinal = {};
    results.forEach(r => { if(r) respostaFinal[r.ticker] = { atual: r.atual, fechamentoAnterior: r.fechamentoAnterior }; });
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
        console.log(`📊 Baixando histórico de ${ticker} via YahooFinance2...`);
        const period1 = calcularDataInicio(range); // Traduz a palavra para data exata
        
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        
        const processados = result.quotes
            .filter(q => q.close !== null && !isNaN(q.close))
            .map(q => ({ 
                time: q.date.toISOString().split('T')[0], 
                close: parseFloat(q.close)
            }));
            
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        return res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        console.log(`❌ Erro no gráfico de ${ticker}: ${erro.message}`); 
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro ao buscar histórico.`}); 
    }
});

// 🚀 NOVA ROTA 3: ANÁLISE TÉCNICA ON-DEMAND (IA)
app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    console.log(`🎯 [IA] Gerando Análise Técnica em tempo real para: ${ticker}`);

    try {
        const period1 = calcularDataInicio('6mo'); // Pede os últimos 6 meses cravados
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: '1d' });
        
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close));
        
        // Limpa os dados para economizar tokens (pega um preço a cada 3 dias)
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => {
            return `${q.date.toISOString().split('T')[0]}: ${q.close.toFixed(2)}`;
        }).join(', ');

        // 2. Prepara o prompt para o Gemini
        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico de preços dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), identifique o SUPORTE mais relevante e a RESISTÊNCIA mais próxima. 
        Retorne APENAS um JSON no formato: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        // 3. Chama a IA
        const resultado = await modeloIA.generateContent(prompt);
        const analiseIA = JSON.parse(resultado.response.text());

        res.json(analiseIA);

    } catch (erro) {
        console.error("❌ Erro na Análise Técnica:", erro.message);
        res.status(500).json({ erro: "Não foi possível gerar a análise agora." });
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));