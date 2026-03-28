import express from 'express';
import cors from 'cors';
import pkg from 'yahoo-finance2'; // Importamos o pacote bruto
const yahooFinance = pkg.default || pkg; // A mágica: Desempacotamos do jeito certo para o Node 22!

const app = express();
app.use(cors());

// ROTA 1: Cotações em Lote 
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    
    const fetchTicker = async (t) => {
        try {
            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1d`;
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const dados = await resposta.json();
            const meta = dados.chart.result[0].meta;
            return { ticker: t, atual: meta.regularMarketPrice, fechamentoAnterior: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice };
        } catch (e) { return null; }
    };

    try {
        const results = await Promise.all(tickers.map(t => fetchTicker(t)));
        const respostaFinal = {};
        results.forEach(r => { if(r) respostaFinal[r.ticker] = { atual: r.atual, fechamentoAnterior: r.fechamentoAnterior }; });
        res.json(respostaFinal);
    } catch (erro) { res.status(500).json({erro: "Falha na API Lote"}); }
});

// ROTA 2: Histórico de Gráficos 
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

// ROTA 3: Indicadores Fundamentalistas
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    
    try {
        const result = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
        });

        res.json({
            pl: result.summaryDetail?.trailingPE,
            pvp: result.defaultKeyStatistics?.priceToBook,
            dy: result.summaryDetail?.dividendYield,
            roe: result.financialData?.returnOnEquity,
            roa: result.financialData?.returnOnAssets,
            margemLiquida: result.financialData?.profitMargins,
            dividaPL: result.financialData?.debtToEquity 
        });
    } catch (erro) {
        console.error(`Erro Indicadores para ${ticker}:`, erro.message);
        res.json({}); 
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA}!`));