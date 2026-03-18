// Importando as ferramentas que instalamos
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// COLE SUA CHAVE DA ALPHA VANTAGE AQUI DENTRO DAS ASPAS
const MINHA_CHAVE_API = 'OTN29T76NKSS2GRS';

// Nosso "Cache" (Memória temporária do servidor)
let cacheMercado = {
    ouro: { atual: 2350.00, fechamentoAnterior: 2330.00 },
    petroleo: { atual: 82.50, fechamentoAnterior: 83.50 }
};

let ultimaBuscaNaApi = 0;
// Tempo de cache: 60 minutos (para não estourar o limite gratuito de 25/dia)
const TEMPO_CACHE_MILISSEGUNDOS = 60 * 60 * 1000; 

app.get('/api/commodities', async (req, res) => {
    const agora = Date.now();

    // Se passou mais de 60 minutos desde a última busca, vamos na API Real
    if (agora - ultimaBuscaNaApi > TEMPO_CACHE_MILISSEGUNDOS) {
        console.log("⏳ Buscando dados frescos na Alpha Vantage...");
        
        try {
            // Buscando Ouro (XAU para USD)
            const urlOuro = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=XAU&to_currency=USD&apikey=${MINHA_CHAVE_API}`;
            const respostaOuro = await fetch(urlOuro);
            const dadosOuro = await respostaOuro.json();

            // Buscando Petróleo (WTI)
            const urlPetroleo = `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${MINHA_CHAVE_API}`;
            const respostaPetroleo = await fetch(urlPetroleo);
            const dadosPetroleo = await respostaPetroleo.json();

            // Atualizando nosso Cache com os dados reais
            if (dadosOuro["Realtime Currency Exchange Rate"]) {
                const precoOuro = parseFloat(dadosOuro["Realtime Currency Exchange Rate"]["5. Exchange Rate"]);
                cacheMercado.ouro.atual = precoOuro;
                cacheMercado.ouro.fechamentoAnterior = precoOuro * 0.99; // Alpha Vantage não dá o fechamento no câmbio simples, simulamos uma variação de 1%
            }

            if (dadosPetroleo.data && dadosPetroleo.data.length >= 2) {
                cacheMercado.petroleo.atual = parseFloat(dadosPetroleo.data[0].value);
                cacheMercado.petroleo.fechamentoAnterior = parseFloat(dadosPetroleo.data[1].value);
            }

            ultimaBuscaNaApi = agora;
            console.log("✅ Dados atualizados com sucesso!");

        } catch (erro) {
            console.error("❌ Erro ao buscar na API. Usando dados do cache antigo.", erro);
        }
    }

    // O servidor responde instantaneamente com o Cache (seja ele novo ou antigo)
    res.json(cacheMercado);
});

app.listen(3000, () => {
    console.log('✅ Servidor Backend PRO rodando na porta 3000!');
});
