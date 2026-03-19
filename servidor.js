const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// O nosso Cache agora guarda os 5 ativos
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
    const resposta = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
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
        console.log("⏳ A buscar dados frescos no Yahoo Finance...");
        try {
            // Buscamos os 5 ativos simultaneamente
            const dadosDolar = await buscarPrecoYahoo('BRL=X');
            const dadosEuro = await buscarPrecoYahoo('EURBRL=X');
            const dadosBitcoin = await buscarPrecoYahoo('BTC-USD');
            const dadosOuro = await buscarPrecoYahoo('GC=F');
            const dadosPetroleo = await buscarPrecoYahoo('BZ=F');

            // Atualizamos o cache
            cacheMercado.dolar = dadosDolar;
            cacheMercado.euro = dadosEuro;
            cacheMercado.bitcoin = dadosBitcoin;
            cacheMercado.ouro = dadosOuro;
            cacheMercado.petroleo = dadosPetroleo;

            ultimaBuscaNaApi = agora;
            console.log("✅ Dados atualizados com sucesso pelo Yahoo Finance!");
        } catch (erro) {
            console.error("❌ Erro ao buscar no Yahoo Finance. A manter cache.", erro.message);
        }
    }

    res.json(cacheMercado);
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`✅ Servidor Backend PRO a correr na porta ${PORTA}!`);
});