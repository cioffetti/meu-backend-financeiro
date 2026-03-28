const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ROTA 1: Cotações em Lote (Agora usando a rota v8/chart que sabemos que funciona!)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    
    const tickers = tickersStr.split(',');
    
    // Função interna para buscar cada ativo na rota v8
    const fetchTicker = async (t) => {
        try {
            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1d`;
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' } });
            const dados = await resposta.json();
            const meta = dados.chart.result[0].meta;
            return {
                ticker: t,
                atual: meta.regularMarketPrice,
                fechamentoAnterior: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice
            };
        } catch (e) { return null; }
    };

    try {
        // Dispara as buscas simultaneamente sem travar o servidor
        const results = await Promise.all(tickers.map(t => fetchTicker(t)));
        const respostaFinal = {};
        results.forEach(r => {
            if(r) respostaFinal[r.ticker] = { atual: r.atual, fechamentoAnterior: r.fechamentoAnterior };
        });
        res.json(respostaFinal);
    } catch (erro) {
        res.status(500).json({erro: "Falha na API Lote"});
    }
});

// ROTA 2: Histórico de Gráficos (Mantida, pois sempre funcionou bem)
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dados = await resposta.json();
        const timestamps = dados.chart.result[0].timestamp;
        const precos = dados.chart.result[0].indicators.quote[0].close;
        const processados = timestamps.map((t, i) => ({
            data: new Date(t * 1000).toISOString().split('T')[0], preco: parseFloat(precos[i]).toFixed(2)
        })).filter(item => item.preco !== "NaN"); 
        res.json({ ticker: ticker, historico: processados });
    } catch (erro) { res.status(500).json({erro: `Erro histórico.`}); }
});

// ROTA 3: Indicadores Fundamentalistas (Agora com proteção contra quebras)
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics,financialData`;
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' } });
        const dados = await resposta.json();
        
        // SISTEMA DE SEGURANÇA: Se o Yahoo bloquear ou não tiver o dado, devolvemos vazio em vez de travar o servidor
        if (!dados.quoteSummary || !dados.quoteSummary.result) {
            return res.json({}); 
        }

        const result = dados.quoteSummary.result[0];
        const getVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part], obj)?.raw || null;

        res.json({
            pl: getVal(result, 'summaryDetail.trailingPE'),
            pvp: getVal(result, 'defaultKeyStatistics.priceToBook'),
            dy: getVal(result, 'summaryDetail.dividendYield'),
            roe: getVal(result, 'financialData.returnOnEquity'),
            roa: getVal(result, 'financialData.returnOnAssets'),
            margemLiquida: getVal(result, 'financialData.profitMargins'),
            dividaPL: getVal(result, 'financialData.debtToEquity') 
        });
    } catch (erro) {
        console.error("Erro Indicadores:", erro.message);
        res.json({}); // Devolve vazio e protege o sistema
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA}!`));