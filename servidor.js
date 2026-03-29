import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const app = express();
app.use(cors());

const cacheIndicadores = {};
const TEMPO_CACHE_INDICADORES = 60 * 60 * 1000;

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
        const quotes = dados.chart.result[0].indicators.quote[0]; 
        
        const processados = timestamps.map((t, i) => ({
            time: new Date(t * 1000).toISOString().split('T')[0], 
            open: parseFloat(quotes.open[i]),
            high: parseFloat(quotes.high[i]),
            low: parseFloat(quotes.low[i]),
            close: parseFloat(quotes.close[i]),
            value: parseFloat(quotes.volume[i]) 
        })).filter(item => !isNaN(item.close) && item.close !== null); 
        
        res.json({ ticker: ticker, historico: processados });
    } catch (erro) { res.status(500).json({erro: `Erro histórico.`}); }
});

// ROTA 3: Indicadores com PROXY DE EMERGÊNCIA
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const agora = Date.now();

    if (cacheIndicadores[ticker] && (agora - cacheIndicadores[ticker].timestamp < TEMPO_CACHE_INDICADORES)) {
        return res.json(cacheIndicadores[ticker].dados);
    }
    
    try {
        // Tentativa 1: O caminho normal
        const result = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
        });

        const dadosFormatados = {
            pl: result.summaryDetail?.trailingPE, pvp: result.defaultKeyStatistics?.priceToBook, dy: result.summaryDetail?.dividendYield,
            roe: result.financialData?.returnOnEquity, roa: result.financialData?.returnOnAssets,
            margemLiquida: result.financialData?.profitMargins, dividaPL: result.financialData?.debtToEquity 
        };

        cacheIndicadores[ticker] = { timestamp: agora, dados: dadosFormatados };
        res.json(dadosFormatados);

    } catch (erro) {
        // DETECTOU O BLOQUEIO 429 DO YAHOO!
        if (erro.message.includes('429') || erro.message.includes('crumb')) {
            console.log(`⚠️ Render bloqueado (429). Acionando Proxy de Emergência para ${ticker}...`);
            try {
                // Tentativa 2: Rota de Fuga usando o Proxy AllOrigins para mascarar nosso IP
                const targetUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics,financialData`;
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
                
                const resProxy = await fetch(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
                const dadosProxy = await resProxy.json();
                
                if(!dadosProxy.quoteSummary) throw new Error("Proxy falhou");

                const result = dadosProxy.quoteSummary.result[0];
                const getVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part], obj)?.raw || null;

                const dadosFormatados = {
                    pl: getVal(result, 'summaryDetail.trailingPE'), pvp: getVal(result, 'defaultKeyStatistics.priceToBook'), dy: getVal(result, 'summaryDetail.dividendYield'),
                    roe: getVal(result, 'financialData.returnOnEquity'), roa: getVal(result, 'financialData.returnOnAssets'),
                    margemLiquida: getVal(result, 'financialData.profitMargins'), dividaPL: getVal(result, 'financialData.debtToEquity') 
                };

                cacheIndicadores[ticker] = { timestamp: agora, dados: dadosFormatados };
                return res.json(dadosFormatados);

            } catch (proxyErro) {
                // Se até o plano B falhar, avisa o site com elegância
                console.error("❌ Proxy de emergência também falhou.");
                return res.json({ status: "bloqueado" }); 
            }
        }
        res.json({}); 
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA}!`));