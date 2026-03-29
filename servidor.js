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

    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro histórico.`}); 
    }
});

// ROTA 3: INDICADORES COMPLETOS (Validade: 30 DIAS)
app.get('/api/indicadores/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const agora = Date.now();
    const VALIDADE_INDICADORES = 30 * 24 * 60 * 60 * 1000; 

    if (cacheMemoria.indicadores[ticker] && (agora - cacheMemoria.indicadores[ticker].timestamp < VALIDADE_INDICADORES)) {
        console.log(`⚡ Retornando Indicadores COMPLETOS de ${ticker} direto do Disco!`);
        return res.json(cacheMemoria.indicadores[ticker].dados);
    }
    
    try {
        const result = await yahooFinance.quoteSummary(ticker, {
            modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
        });

        // Extraindo a verdadeira avalanche de dados!
        const dadosFormatados = {
            // Valuation
            pl: result.summaryDetail?.trailingPE,
            pvp: result.defaultKeyStatistics?.priceToBook,
            dy: result.summaryDetail?.dividendYield,
            pegRatio: result.defaultKeyStatistics?.pegRatio,
            evEbitda: result.defaultKeyStatistics?.enterpriseToEbitda,
            vpa: result.defaultKeyStatistics?.bookValue,
            lpa: result.defaultKeyStatistics?.trailingEps,
            psr: result.summaryDetail?.priceToSalesTrailing12Months,
            // Rentabilidade
            roe: result.financialData?.returnOnEquity,
            roa: result.financialData?.returnOnAssets,
            // Eficiência
            margemBruta: result.financialData?.grossMargins,
            margemOperacional: result.financialData?.operatingMargins,
            margemLiquida: result.financialData?.profitMargins,
            // Endividamento
            dividaPL: result.financialData?.debtToEquity,
            liquidezCorrente: result.financialData?.currentRatio
        };

        cacheMemoria.indicadores[ticker] = { timestamp: agora, dados: dadosFormatados };
        salvarNoDisco(); 
        res.json(dadosFormatados);

    } catch (erro) {
        if (cacheMemoria.indicadores[ticker]) {
            console.log(`🛡️ Escudo ativado! Dados antigos para ${ticker}.`);
            return res.json(cacheMemoria.indicadores[ticker].dados);
        }
        res.json({ status: "bloqueado" }); 
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor Backend PRO na porta ${PORTA} com Disco Rígido ativado!`));