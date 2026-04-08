import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';
import yahooFinance from 'yahoo-finance2'; 

yahooFinance.suppressNotices(['yahooSurvey']);

const app = express();
app.use(cors());
app.use(express.json()); 

// 1. CONFIGURAÇÃO DA IA (GEMINI)
const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);
const modeloIA = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

const ARQUIVO_CACHE = './banco_de_dados.json';
let cacheMemoria = { cotacoes: {}, historico: {} };

if (fs.existsSync(ARQUIVO_CACHE)) {
    try { cacheMemoria = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8')); } catch (e) {}
}

function salvarNoDisco() {
    try { fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify(cacheMemoria), 'utf8'); } catch (e) {}
}

// 🛡️ A PORTA LATERAL DO DIRETOR (Fallback Nativo via Web)
// Se a biblioteca oficial for bloqueada, usamos o protocolo puro do navegador
async function buscarPrecoPeloGrafico(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2d&interval=1d`;
    const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resposta.ok) throw new Error('Falha no fallback nativo');
    
    const dados = await resposta.json();
    const meta = dados.chart.result[0].meta;
    
    return {
        atual: meta.regularMarketPrice,
        fechamentoAnterior: meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice
    };
}

// 🚀 ROTA 1: Cotações em Lote (Com Fracionamento e Fallback)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    const tickersParaAtualizar = tickers.filter(t => !cacheMemoria.cotacoes[t] || (agora - cacheMemoria.cotacoes[t].timestamp >= 300000));

    // FRACIONAMENTO: Divide os 80 ativos em pacotes de 20 para não assustar o Yahoo
    const lotes = [];
    for (let i = 0; i < tickersParaAtualizar.length; i += 20) {
        lotes.push(tickersParaAtualizar.slice(i, i + 20));
    }

    for (const lote of lotes) {
        try {
            // Tenta a porta da frente oficial
            const resultadosApi = await yahooFinance.quote(lote);
            const resultadosArray = Array.isArray(resultadosApi) ? resultadosApi : [resultadosApi];

            resultadosArray.forEach(item => {
                if (item && item.symbol) {
                    cacheMemoria.cotacoes[item.symbol] = {
                        timestamp: agora,
                        dados: { ticker: item.symbol, atual: item.regularMarketPrice, fechamentoAnterior: item.regularMarketPreviousClose || item.regularMarketPrice }
                    };
                }
            });
        } catch (e) {
            console.log(`⚠️ Lote bloqueado (429). Ativando Porta Lateral para os ativos...`);
            // O SEU ARRANJO: Se a cotação falhar, entra pela porta do gráfico um por um!
            for (const t of lote) {
                try {
                    const precos = await buscarPrecoPeloGrafico(t);
                    cacheMemoria.cotacoes[t] = {
                        timestamp: agora,
                        dados: { ticker: t, atual: precos.atual, fechamentoAnterior: precos.fechamentoAnterior }
                    };
                } catch (err) {
                    console.log(`Falha dupla no ativo ${t}`);
                }
            }
        }
    }
    
    if (tickersParaAtualizar.length > 0) salvarNoDisco();

    const respostaFinal = {};
    tickers.forEach(t => {
        if (cacheMemoria.cotacoes[t]) {
            respostaFinal[t] = cacheMemoria.cotacoes[t].dados;
        }
    });

    res.json(respostaFinal);
});

// 📊 ROTA 2: Histórico para Gráficos (Com Fallback)
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
        let processados = [];
        try {
            // Tentativa Oficial
            const period1 = new Date(); period1.setMonth(period1.getMonth() - (range === '6mo' ? 6 : 1));
            const result = await yahooFinance.chart(ticker, { period1: period1.toISOString().split('T')[0], interval: interval });
            processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close)).map(q => ({ time: q.date.toISOString().split('T')[0], close: parseFloat(q.close) }));
        } catch (e) {
            // Tentativa via Porta Lateral
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const dados = await resposta.json();
            const timestamps = dados.chart.result[0].timestamp;
            const quotes = dados.chart.result[0].indicators.quote[0];
            
            for(let i=0; i<timestamps.length; i++){
                if(quotes.close[i] !== null) {
                    processados.push({ time: new Date(timestamps[i] * 1000).toISOString().split('T')[0], close: parseFloat(quotes.close[i]) });
                }
            }
        }
            
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        return res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro ao buscar histórico.`}); 
    }
});

// 🎯 ROTA 3: ANÁLISE TÉCNICA ON-DEMAND (Intacta, funcionando perfeitamente)
app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    try {
        const period1 = new Date(); period1.setMonth(period1.getMonth() - 6);
        const result = await yahooFinance.chart(ticker, { period1: period1.toISOString().split('T')[0], interval: '1d' });
        
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close));
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => `${q.date.toISOString().split('T')[0]}: ${q.close.toFixed(2)}`).join(', ');

        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), o SUPORTE mais relevante e a RESISTÊNCIA. 
        Retorne APENAS JSON: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        const resultado = await modeloIA.generateContent(prompt);
        res.json(JSON.parse(resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim()));
    } catch (erro) {
        res.status(500).json({ erro: "Erro na IA ou Bloqueio 429." });
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor BLINDADO PRO na porta ${PORTA}!`));