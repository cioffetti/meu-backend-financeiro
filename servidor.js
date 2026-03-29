import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';
import fs from 'fs'; 

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
app.use(cors());

// --- SISTEMA DE BANCO DE DADOS LOCAL ---
const ARQUIVO_CACHE = './banco_de_dados.json';
let cacheMemoria = { cotacoes: {}, historico: {}, indicadores: {} };

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

// ROTA 1: Cotações em Lote (Validade: 5 minutos)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    const VALIDADE_COTACOES = 5 * 60 * 1000; 

    const fetchTicker = async (t) => {
        if (cacheMemoria.cotacoes[t] && (agora - cacheMemoria.cotacoes[t].timestamp < VALIDADE_COTACOES)) {
            return cacheMemoria.cotacoes[t].dados;
        }
        try {
            const url = `https://query2.finance.yahoo.com/v8/finance/chart/${t}?range=1d&interval=1d`;
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resposta.ok) throw new Error("Erro 429");
            const dados = await resposta.json();
            const meta = dados.chart.result[0].meta;
            const resultado = { ticker: t, atual: meta.regularMarketPrice, fechamentoAnterior: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice };
            cacheMemoria.cotacoes[t] = { timestamp: agora, dados: resultado };
            return resultado;
        } catch (e) {
            if (cacheMemoria.cotacoes[t]) return cacheMemoria.cotacoes[t].dados;
            return null;
        }
    };

    const results = await Promise.all(tickers.map(t => fetchTicker(t)));
    salvarNoDisco(); 
    
    const respostaFinal = {};
    results.forEach(r => { if(r) respostaFinal[r.ticker] = { atual: r.atual, fechamentoAnterior: r.fechamentoAnterior }; });
    res.json(respostaFinal);
});

// ROTA 2: Histórico de Gráficos (Validade: 1 hora)
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const chave = `${ticker}-${range}`; 
    const agora = Date.now();
    const VALIDADE_HISTORICO = 60 * 60 * 1000; 

    if (cacheMemoria.historico[chave] && (agora - cacheMemoria.historico[chave].timestamp < VALIDADE_HISTORICO)) {
        return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
    }

    const targetUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
    
    try {
        // Tentativa 1: Normal
        const resposta = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!resposta.ok) throw new Error("Erro 429");
        const dados = await resposta.json();
        const timestamps = dados.chart.result[0].timestamp;
        const quotes = dados.chart.result[0].indicators.quote[0]; 
        
        const processados = timestamps.map((t, i) => ({
            time: new Date(t * 1000).toISOString().split('T')[0], 
            open: parseFloat(quotes.open[i]), high: parseFloat(quotes.high[i]), low: parseFloat(quotes.low[i]),
            close: parseFloat(quotes.close[i]), value: parseFloat(quotes.volume[i]) 
        })).filter(item => !isNaN(item.close) && item.close !== null); 
        
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        console.log(`⚠️ Gráfico de ${ticker} bloqueado. Tentando Proxy de Fuga...`);
        try {
            // Tentativa 2: Proxy
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
            const resProxy = await fetch(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const dadosProxy = await resProxy.json();
            const timestamps = dadosProxy.chart.result[0].timestamp;
            const quotes = dadosProxy.chart.result[0].indicators.quote[0]; 
            
            const processados = timestamps.map((t, i) => ({
                time: new Date(t * 1000).toISOString().split('T')[0], 
                open: parseFloat(quotes.open[i]), high: parseFloat(quotes.high[i]), low: parseFloat(quotes.low[i]),
                close: parseFloat(quotes.close[i]), value: parseFloat(quotes.volume[i]) 
            })).filter(item => !isNaN(item.close) && item.close !== null); 
            
            cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
            salvarNoDisco();
            return res.json({ ticker: ticker, historico: processados });
        } catch (erroProxy) {
            console.error(`❌ Proxy do gráfico também falhou para ${ticker}. Acionando Escudo.`);
            if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
            res.status(500).json({erro: `Erro histórico.`}); 
        }
    }
});

// ROTA 3: INDICADORES COMPLETOS (Validade: 30 DIAS)
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const agora = Date.now();
    const VALIDADE_INDICADORES = 30 * 24 * 60 * 60 * 1000; 

    if (cacheMemoria.indicadores[ticker] && (agora - cacheMemoria.indicadores[ticker].timestamp < VALIDADE_INDICADORES)) {
        console.log(`⚡ Retornando Indicadores de ${ticker} direto do Disco!`);
        return res.json(cacheMemoria.indicadores[ticker].dados);
    }
    
    try {
        // Tentativa 1: Oficial
        const result = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
        });

        const dadosFormatados = {
            pl: result.summaryDetail?.trailingPE, pvp: result.defaultKeyStatistics?.priceToBook, dy: result.summaryDetail?.dividendYield,
            pegRatio: result.defaultKeyStatistics?.pegRatio, evEbitda: result.defaultKeyStatistics?.enterpriseToEbitda, vpa: result.defaultKeyStatistics?.bookValue,
            lpa: result.defaultKeyStatistics?.trailingEps, psr: result.summaryDetail?.priceToSalesTrailing12Months, roe: result.financialData?.returnOnEquity,
            roa: result.financialData?.returnOnAssets, margemBruta: result.financialData?.grossMargins, margemOperacional: result.financialData?.operatingMargins,
            margemLiquida: result.financialData?.profitMargins, dividaPL: result.financialData?.debtToEquity, liquidezCorrente: result.financialData?.currentRatio
        };

        cacheMemoria.indicadores[ticker] = { timestamp: agora, dados: dadosFormatados };
        salvarNoDisco(); 
        res.json(dadosFormatados);

    } catch (erro) {
        console.log(`⚠️ Indicadores de ${ticker} bloqueados. Tentando Proxy de Fuga...`);
        try {
            // Tentativa 2: Proxy
            const targetUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,defaultKeyStatistics,financialData`;
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
            const resProxy = await fetch(proxyUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
            const dadosProxy = await resProxy.json();
            
            const result = dadosProxy.quoteSummary.result[0];
            const getVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part], obj)?.raw || null;

            const dadosFormatados = {
                pl: getVal(result, 'summaryDetail.trailingPE'), pvp: getVal(result, 'defaultKeyStatistics.priceToBook'), dy: getVal(result, 'summaryDetail.dividendYield'),
                pegRatio: getVal(result, 'defaultKeyStatistics.pegRatio'), evEbitda: getVal(result, 'defaultKeyStatistics.enterpriseToEbitda'), vpa: getVal(result, 'defaultKeyStatistics.bookValue'),
                lpa: getVal(result, 'defaultKeyStatistics.trailingEps'), psr: getVal(result, 'summaryDetail.priceToSalesTrailing12Months'), roe: getVal(result, 'financialData.returnOnEquity'),
                roa: getVal(result, 'financialData.returnOnAssets'), margemBruta: getVal(result, 'financialData.grossMargins'), margemOperacional: getVal(result, 'financialData.operatingMargins'),
                margemLiquida: getVal(result, 'financialData.profitMargins'), dividaPL: getVal(result, 'financialData.debtToEquity'), liquidezCorrente: getVal(result, 'financialData.currentRatio')
            };

            cacheMemoria.indicadores[ticker] = { timestamp: agora, dados: dadosFormatados };
            salvarNoDisco(); 
            return res.json(dadosFormatados);

        } catch (erroProxy) {
            console.error(`❌ Proxy também falhou para ${ticker}. Acionando Escudo.`);
            if (cacheMemoria.indicadores[ticker]) {
                return res.json(cacheMemoria.indicadores[ticker].dados);
            }
            res.json({ status: "bloqueado" }); 
        }
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA} com Disco Rígido ativado!`));