const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Nosso "Cache" (Memória temporária do servidor)
let cacheMercado = {
    ouro: { atual: 2350.00, fechamentoAnterior: 2330.00 },
    petroleo: { atual: 82.50, fechamentoAnterior: 83.50 }
};

let ultimaBuscaNaApi = 0;
// Tempo de cache reduzido: 5 minutos (O Yahoo Finance é bem mais flexível!)
const TEMPO_CACHE_MILISSEGUNDOS = 5 * 60 * 1000; 

// Função isolada para buscar os dados direto no motor do Yahoo
async function buscarPrecoYahoo(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;
    const resposta = await fetch(url);
    const dados = await resposta.json();
    
    const resultado = dados.chart.result[0].meta;
    return {
        atual: resultado.regularMarketPrice,
        fechamentoAnterior: resultado.previousClose || resultado.chartPreviousClose
    };
}

app.get('/api/commodities', async (req, res) => {
    const agora = Date.now();

    // Se passou mais de 5 minutos, vamos na API Real do Yahoo
    if (agora - ultimaBuscaNaApi > TEMPO_CACHE_MILISSEGUNDOS) {
        console.log("⏳ Buscando dados frescos no Yahoo Finance...");
        
        try {
            // GC=F é o código oficial do Ouro, BZ=F é o do Petróleo Brent no Yahoo
            const dadosOuro = await buscarPrecoYahoo('GC=F');
            const dadosPetroleo = await buscarPrecoYahoo('BZ=F');

            cacheMercado.ouro = dadosOuro;
            cacheMercado.petroleo = dadosPetroleo;

            ultimaBuscaNaApi = agora;
            console.log("✅ Dados atualizados com sucesso pelo Yahoo Finance!");

        } catch (erro) {
            console.error("❌ Erro ao buscar no Yahoo Finance. Mantendo cache.", erro.message);
        }
    }

    // O servidor responde instantaneamente com o Cache
    res.json(cacheMercado);
});

// A porta dinâmica (process.env.PORT) é o padrão ouro para hospedar no Render
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`✅ Servidor Backend PRO rodando na porta ${PORTA}!`);
});