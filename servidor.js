import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';
import YahooFinance from 'yahoo-finance2'; 

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const app = express();
app.use(cors());
app.use(express.json()); 

const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);
const modeloIA = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig: { responseMimeType: "application/json" } });

const ARQUIVO_CACHE = './banco_de_dados.json';
let cacheMemoria = { cotacoes: {}, historico: {} };
let dbEstatico = {}; // O Cofre

// Tenta carregar o cofre logo que liga
try { if (fs.existsSync('./indicadores.json')) dbEstatico = JSON.parse(fs.readFileSync('./indicadores.json', 'utf8')); } catch(e) {}
if (fs.existsSync(ARQUIVO_CACHE)) { try { cacheMemoria = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8')); } catch(e){} }

function salvarNoDisco() { try { fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify(cacheMemoria), 'utf8'); } catch(e){} }

function calcularDataInicio(range) {
    const data = new Date();
    if (range === '1mo') data.setMonth(data.getMonth() - 1);
    else if (range === '6mo') data.setMonth(data.getMonth() - 6);
    else if (range === '1y') data.setFullYear(data.getFullYear() - 1);
    else if (range === '5y') data.setFullYear(data.getFullYear() - 5);
    else data.setMonth(data.getMonth() - 1); 
    return data.toISOString().split('T')[0]; 
}

// 🛡️ ROTA 1: Cotações (A PROVA DE 429)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    const tickersParaAtualizar = tickers.filter(t => !cacheMemoria.cotacoes[t] || (agora - cacheMemoria.cotacoes[t].timestamp >= 300000));

    if (tickersParaAtualizar.length > 0) {
        try {
            const resultadosApi = await yahooFinance.quote(tickersParaAtualizar);
            const resultadosArray = Array.isArray(resultadosApi) ? resultadosApi : [resultadosApi];
            resultadosArray.forEach(item => {
                if (item && item.symbol) {
                    cacheMemoria.cotacoes[item.symbol] = { timestamp: agora, dados: { ticker: item.symbol, atual: item.regularMarketPrice, fechamentoAnterior: item.regularMarketPreviousClose || item.regularMarketPrice } };
                }
            });
            salvarNoDisco();
        } catch (e) { 
            console.log(`⚠️ Yahoo deu 429. Puxando cotações do Cofre de Segurança!`);
            // Se der erro, pega o preço antigo que o robô salvou para não travar a tela!
            tickersParaAtualizar.forEach(t => {
                if(dbEstatico[t] && dbEstatico[t].precoAtual) {
                    cacheMemoria.cotacoes[t] = { timestamp: agora, dados: { ticker: t, atual: dbEstatico[t].precoAtual, fechamentoAnterior: dbEstatico[t].precoAtual } };
                }
            });
        }
    }

    const respostaFinal = {};
    tickers.forEach(t => { if (cacheMemoria.cotacoes[t]) respostaFinal[t] = cacheMemoria.cotacoes[t].dados; });
    res.json(respostaFinal);
});

app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const chave = `${ticker}-${range}`; 
    const agora = Date.now();

    if (cacheMemoria.historico[chave] && (agora - cacheMemoria.historico[chave].timestamp < 3600000)) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });

    try {
        const period1 = calcularDataInicio(range); 
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close)).map(q => ({ time: q.date.toISOString().split('T')[0], close: parseFloat(q.close) }));
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        return res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro ao buscar histórico.`}); 
    }
});

app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    try {
        const period1 = calcularDataInicio('6mo'); 
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: '1d' });
        const processados = result.quotes.filter(q => q.close !== null && !isNaN(q.close));
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => `${q.date.toISOString().split('T')[0]}: ${q.close.toFixed(2)}`).join(', ');

        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), o SUPORTE mais relevante e a RESISTÊNCIA. 
        Retorne APENAS JSON: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        const resultado = await modeloIA.generateContent(prompt);
        res.json(JSON.parse(resultado.response.text().replace(/```json/gi, '').replace(/```/gi, '').trim()));
    } catch (erro) { res.status(500).json({ erro: "O Gráfico não tem dados recentes para a IA ler." }); }
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log(`✅ Servidor HÍBRIDO PRO na porta ${PORTA}!`));