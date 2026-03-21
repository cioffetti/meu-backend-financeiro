const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

let cacheMercado = {
    dolar: { atual: 5.00, fechamentoAnterior: 4.95 },
    euro: { atual: 5.40, fechamentoAnterior: 5.35 },
    bitcoin: { atual: 65000.00, fechamentoAnterior: 64000.00 },
    ouro: { atual: 2350.00, fechamentoAnterior: 2330.00 },
    petroleo: { atual: 82.50, fechamentoAnterior: 83.50 }
};

let ultimaBuscaNaApi = 0;
const TEMPO_CACHE_MILISSEGUNDOS = 5 * 60 * 1000; 

async function buscarPrecoYahoo(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;
    const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const dados = await resposta.json();
    const resultado = dados.chart.result[0].meta;
    return {
        atual: resultado.regularMarketPrice,
        fechamentoAnterior: resultado.previousClose || resultado.chartPreviousClose
    };
}

app.get('/api/commodities', async (req, res) => {
    const agora = Date.now();
    if (agora - ultimaBuscaNaApi > TEMPO_CACHE_MILISSEGUNDOS) {
        try {
            cacheMercado.dolar = await buscarPrecoYahoo('BRL=X');
            cacheMercado.euro = await buscarPrecoYahoo('EURBRL=X');
            cacheMercado.bitcoin = await buscarPrecoYahoo('BTC-USD');
            cacheMercado.ouro = await buscarPrecoYahoo('GC=F');
            cacheMercado.petroleo = await buscarPrecoYahoo('BZ=F');
            ultimaBuscaNaApi = agora;
        } catch (erro) { console.error("Erro no Yahoo. Mantendo cache."); }
    }
    res.json(cacheMercado);
});

// NOVA ROTA DE HISTÓRICO DINÂMICO
// Agora ela aceita queries, ex: /api/historico/BTC-USD?range=5y&interval=1wk
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    
    // Se o site não pedir um período específico, usamos 1 mês por padrão
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';

    const urlHistorico = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;

    try {
        const resposta = await fetch(urlHistorico, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dados = await resposta.json();
        
        const timestamps = dados.chart.result[0].timestamp;
        const precos = dados.chart.result[0].indicators.quote[0].close;

        const dadosProcessados = timestamps.map((timestamp, index) => {
            return {
                data: new Date(timestamp * 1000).toISOString().split('T')[0],
                preco: parseFloat(precos[index]).toFixed(2)
            };
        }).filter(item => item.preco !== "NaN"); // Remove dias sem negociação

        res.json({ ticker: ticker, historico: dadosProcessados });

    } catch (erro) {
        res.status(500).json({erro: `Erro ao buscar histórico.`});
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`✅ Servidor Backend PRO rodando na porta ${PORTA}!`);
});