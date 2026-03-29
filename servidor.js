import express from 'express';
import cors from 'cors';
import fs from 'fs'; 

const app = express();
app.use(cors());
app.use(express.json()); 

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

// ROTA 1: Cotações em Lote (Mantida intacta)
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

// ROTA 2: GRÁFICOS COM RADAR ATIVADO
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const chave = `${ticker}-${range}`; 
    const agora = Date.now();

    console.log(`\n📊 Solicitado gráfico para: ${ticker}`);

    if (cacheMemoria.historico[chave] && (agora - cacheMemoria.historico[chave].timestamp < 3600000)) {
        console.log(`   ⚡ Retornando gráfico do Cache/Disco.`);
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
            console.log(`   🌐 Tentando: ${tentativa.nome}...`);
            const resposta = await fetch(tentativa.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
            
            const dados = await resposta.json();
            if (!dados.chart || !dados.chart.result) throw new Error("JSON Bloqueado");

            const timestamps = dados.chart.result[0].timestamp;
            const quotes = dados.chart.result[0].indicators.quote[0]; 
            
            const processados = timestamps.map((t, i) => ({ 
                time: new Date(t * 1000).toISOString().split('T')[0], 
                open: parseFloat(quotes.open[i]), high: parseFloat(quotes.high[i]), low: parseFloat(quotes.low[i]), 
                close: parseFloat(quotes.close[i]), value: parseFloat(quotes.volume[i]) 
            })).filter(item => !isNaN(item.close) && item.close !== null); 
            
            cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
            salvarNoDisco();
            console.log(`   ✅ Sucesso no gráfico via ${tentativa.nome}!`);
            return res.json({ ticker: ticker, historico: processados });
        } catch (erro) { console.log(`   ❌ Falha em ${tentativa.nome}: ${erro.message}`); }
    }

    console.log(`🚨 Todas as tentativas falharam para o gráfico de ${ticker}.`);
    if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
    res.status(500).json({erro: `Erro histórico.`}); 
});

// Rota 3 (Indicadores) foi removida do backend, pois agora o site lê o arquivo local do GitHub!

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));