import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';

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

// ROTA 1: Cotações em Lote
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    const fetchTicker = async (t) => {
        if (cacheMemoria.cotacoes[t] && (agora - cacheMemoria.cotacoes[t].timestamp < 300000)) return cacheMemoria.cotacoes[t].dados;
        try {
            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1d`;
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resposta.ok) throw new Error("Erro");
            const dados = await resposta.json();
            const meta = dados.chart.result[0].meta;
            const resultado = { ticker: t, atual: meta.regularMarketPrice, fechamentoAnterior: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice };
            cacheMemoria.cotacoes[t] = { timestamp: agora, dados: resultado };
            return resultado;
        } catch (e) { return cacheMemoria.cotacoes[t] ? cacheMemoria.cotacoes[t].dados : null; }
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

    const targetUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
    const listaUrls = [
        { nome: 'Oficial', url: targetUrl },
        { nome: 'Proxy 1', url: `https://corsproxy.io/?${encodeURIComponent(targetUrl)}` },
        { nome: 'Proxy 2', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}` }
    ];

    for (let tentativa of listaUrls) {
        try {
            const resposta = await fetch(tentativa.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
            const dados = await resposta.json();
            const timestamps = dados.chart.result[0].timestamp;
            const quotes = dados.chart.result[0].indicators.quote[0]; 
            const processados = timestamps.map((t, i) => ({ 
                time: new Date(t * 1000).toISOString().split('T')[0], 
                close: parseFloat(quotes.close[i])
            })).filter(item => !isNaN(item.close)); 
            
            cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
            salvarNoDisco();
            return res.json({ ticker: ticker, historico: processados });
        } catch (erro) { console.log(`Erro na tentativa ${tentativa.nome}: ${erro.message}`); }
    }
    res.status(500).json({erro: `Erro ao buscar histórico.`}); 
});

// 🚀 NOVA ROTA 3: ANÁLISE TÉCNICA ON-DEMAND (IA)
app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    console.log(`🎯 [IA] Gerando Análise Técnica em tempo real para: ${ticker}`);

    try {
        // 1. Busca os últimos 6 meses de dados para a IA analisar
        const urlDados = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`;
        const respYahoo = await fetch(urlDados, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dadosYahoo = await respYahoo.json();
        
        const timestamps = dadosYahoo.chart.result[0].timestamp;
        const prices = dadosYahoo.chart.result[0].indicators.quote[0].close;
        
        // Limpa os dados para economizar tokens (pega um preço a cada 3 dias)
        const resumoPrecos = timestamps.filter((_, i) => i % 3 === 0).map((t, i) => {
            return `${new Date(t * 1000).toISOString().split('T')[0]}: ${prices[i]?.toFixed(2)}`;
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