const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ROTA 1: Cotações em Lote (Mantida)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickers = req.query.tickers; 
    if (!tickers) return res.json({});
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}`;
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dados = await resposta.json();
        const resultados = {};
        if (dados.quoteResponse && dados.quoteResponse.result) {
            dados.quoteResponse.result.forEach(ativo => {
                resultados[ativo.symbol] = {
                    atual: ativo.regularMarketPrice,
                    fechamentoAnterior: ativo.regularMarketPreviousClose
                };
            });
        }
        res.json(resultados);
    } catch (erro) { res.status(500).json({erro: "Falha na API Lote"}); }
});

// ROTA 2: Histórico de Gráficos (Mantida)
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
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

// ROTA 3: NOVA! Indicadores Fundamentalistas
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    // Módulo secreto do Yahoo para dados contábeis
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics,financialData`;
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dados = await resposta.json();
        const result = dados.quoteSummary.result[0];

        // Função para extrair o dado com segurança sem quebrar se vier vazio
        const getVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part], obj)?.raw || null;

        const indicadores = {
            pl: getVal(result, 'summaryDetail.trailingPE'),
            pvp: getVal(result, 'defaultKeyStatistics.priceToBook'),
            dy: getVal(result, 'summaryDetail.dividendYield'), // Vem em decimal (ex: 0.05 = 5%)
            roe: getVal(result, 'financialData.returnOnEquity'),
            roa: getVal(result, 'financialData.returnOnAssets'),
            margemLiquida: getVal(result, 'financialData.profitMargins'),
            dividaPL: getVal(result, 'financialData.debtToEquity') // Vem como ex: 80 para 0.8x
        };
        res.json(indicadores);
    } catch (erro) {
        console.error("Erro Indicadores:", erro.message);
        res.status(500).json({erro: "Erro ao buscar indicadores"});
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA}!`));