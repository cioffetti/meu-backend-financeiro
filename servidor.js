import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';
import fs from 'fs'; 

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
app.use(cors());
app.use(express.json()); // PERMITE QUE O SERVIDOR RECEBA PACOTES DE DADOS!

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

// ROTA 1: Cotações em Lote (Igual)
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

// ROTA 2: Histórico de Gráficos (AGORA BLINDADA COM ROTAÇÃO DE PROXY)
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
    
    // A nossa mala de disfarces para os gráficos
    const listaUrls = [
        targetUrl, // Tenta direto primeiro
        `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
    ];

    for (let url of listaUrls) {
        try {
            const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resposta.ok) continue; // Se bloqueou, pula pro próximo disfarce imediatamente
            
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
            return res.json({ ticker: ticker, historico: processados }); // Deu certo, entrega o gráfico e sai do loop!
        } catch (erro) { /* Silencia o erro e tenta a próxima URL */ }
    }

    // Se a CVM e o FBI bloquearem todos os nossos proxies:
    if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
    res.status(500).json({erro: `Erro histórico.`}); 
});
// ROTA 3: INDICADORES (AGORA É SOMENTE LEITURA - IMUNE A BLOQUEIOS)
app.get('/api/indicadores/:ticker', (req, res) => {
    const ticker = req.params.ticker;
    
    // O Render só olha para o disco rígido. Se tiver lá, ele manda pro site.
    if (cacheMemoria.indicadores[ticker]) {
        return res.json(cacheMemoria.indicadores[ticker].dados);
    }
    
    // Se não tiver, ele avisa o site que o seu Robô precisa trabalhar
    res.json({ status: "aguardando_robo" }); 
});

// =========================================================================
// ROTA MESTRA (PORTA DOS FUNDOS): POR AQUI O SEU COMPUTADOR MANDA OS DADOS
// =========================================================================
app.post('/api/abastecer-indicadores', (req, res) => {
    const { senha, ticker, dados } = req.body;
    
    // Segurança: Só aceita pacotes se a senha for a nossa!
    if (senha !== "ProjetoMarcelo2026") {
        return res.status(401).json({ erro: "Acesso Negado. Senha incorreta." });
    }

    // Guarda os dados que vieram do seu computador na memória do Render
    cacheMemoria.indicadores[ticker] = {
        timestamp: Date.now(),
        dados: dados
    };
    
    salvarNoDisco(); // Tranca no cofre
    console.log(`📦 PACOTE RECEBIDO DO ROBÔ: Indicadores de ${ticker} salvos com sucesso!`);
    
    res.json({ sucesso: true, mensagem: `${ticker} abastecido!` });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));