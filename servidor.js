const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Cache para os 5 ativos atuais
let cacheMercado = {
    dolar: { atual: 5.00, fechamentoAnterior: 4.95 },
    euro: { atual: 5.40, fechamentoAnterior: 5.35 },
    bitcoin: { atual: 65000.00, fechamentoAnterior: 64000.00 },
    ouro: { atual: 2350.00, fechamentoAnterior: 2330.00 },
    petroleo: { atual: 82.50, fechamentoAnterior: 83.50 }
};

let ultimaBuscaNaApi = 0;
const TEMPO_CACHE_MILISSEGUNDOS = 5 * 60 * 1000; // 5 minutos

// Função genérica para buscar o preço atual no Yahoo
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

// ROTA ATUAL: Entrega os 5 ativos atuais
app.get('/api/commodities', async (req, res) => {
    const agora = Date.now();

    if (agora - ultimaBuscaNaApi > TEMPO_CACHE_MILISSEGUNDOS) {
        console.log("⏳ A buscar dados frescos no Yahoo Finance...");
        try {
            const dadosDolar = await buscarPrecoYahoo('BRL=X');
            const dadosEuro = await buscarPrecoYahoo('EURBRL=X');
            const dadosBitcoin = await buscarPrecoYahoo('BTC-USD');
            const dadosOuro = await buscarPrecoYahoo('GC=F');
            const dadosPetroleo = await buscarPrecoYahoo('BZ=F');

            cacheMercado.dolar = dadosDolar;
            cacheMercado.euro = dadosEuro;
            cacheMercado.bitcoin = dadosBitcoin;
            cacheMercado.ouro = dadosOuro;
            cacheMercado.petroleo = dadosPetroleo;

            ultimaBuscaNaApi = agora;
            console.log("✅ Dados atuais atualizados com sucesso!");
        } catch (erro) {
            console.error("❌ Erro ao buscar dados atuais no Yahoo. A manter cache.", erro.message);
        }
    }

    res.json(cacheMercado);
});

// NOVA ROTA: Entrega o histórico de 30 dias para UM ativo específico
// Ex: /api/historico/GC=F
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    
    // Calculando o timestamp de 30 dias atrás
    const end_timestamp = Math.floor(Date.now() / 1000);
    const start_timestamp = end_timestamp - (30 * 24 * 60 * 60);

    const urlHistorico = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?symbol=${ticker}&period1=${start_timestamp}&period2=${end_timestamp}&useYfid=true&interval=1d`;
    
    console.log(`⏳ A buscar histórico de 30 dias para ${ticker} no Yahoo Finance...`);

    try {
        const resposta = await fetch(urlHistorico, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const dados = await resposta.json();
        
        const timestamps = dados.chart.result[0].timestamp;
        const precos = dados.chart.result[0].indicators.quote[0].close;

        // Processando os dados para entregar um formato limpo: [{data, preco}, ...]
        const dadosProcessados = timestamps.map((timestamp, index) => {
            return {
                data: new Date(timestamp * 1000).toISOString().split('T')[0],
                preco: parseFloat(precos[index]).toFixed(2)
            };
        });

        console.log(`✅ Histórico de ${ticker} entregue com sucesso!`);
        res.json({
            ticker: ticker,
            historico: dadosProcessados
        });

    } catch (erro) {
        console.error(`❌ Erro ao buscar histórico de ${ticker} no Yahoo.`, erro.message);
        res.status(500).json({erro: `Erro ao buscar histórico de ${ticker}.`});
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`✅ Servidor Backend PRO a correr na porta ${PORTA}!`);
});