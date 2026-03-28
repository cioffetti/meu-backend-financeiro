const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// NOVA ROTA: Busca dezenas de cotações em uma única chamada (Alta Performance)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickers = req.query.tickers; // Ex: AAPL,MSFT,PETR4.SA
    if (!tickers) return res.json({});

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}`;
    
    try {
        const resposta = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const dados = await resposta.json();
        
        const resultados = {};
        if (dados.quoteResponse && dados.quoteResponse.result) {
            dados.quoteResponse.result.forEach(ativo => {
                resultados[ativo.symbol] = {
                    atual: ativo.regularMarketPrice,
                    fechamentoAnterior: ativo.regularMarketPreviousClose
                };
            });
        }
        res.json(resultados);
    } catch (erro) {
        console.error("Erro ao buscar em lote:", erro.message);
        res.status(500).json({erro: "Falha na API"});
    }
});

// ROTA DE HISTÓRICO (Mantida igual, pois já suporta o gráfico de 5 anos)
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
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
        }).filter(item => item.preco !== "NaN"); 

        res.json({ ticker: ticker, historico: dadosProcessados });

    } catch (erro) {
        res.status(500).json({erro: `Erro ao buscar histórico de ${ticker}.`});
    }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
    console.log(`✅ Servidor Backend PRO rodando na porta ${PORTA}!`);
});