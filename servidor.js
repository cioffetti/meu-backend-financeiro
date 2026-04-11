import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs'; 
import { GoogleGenerativeAI } from '@google/generative-ai';
import YahooFinance from 'yahoo-finance2'; 

// ==========================================
// 🔑 1. CONFIGURAÇÕES INICIAIS E IA
// ==========================================
const app = express();
app.use(cors());
app.use(express.json()); 

// Silencia os avisos chatos do Yahoo Finance no log
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Inicializa o Google Gemini
const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);
const modeloIA = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

// ==========================================
// 🧠 2. SISTEMA DE MEMÓRIA E CACHE (Alta Performance)
// ==========================================
const ARQUIVO_CACHE = './banco_de_dados.json';

// Cache Longo (Salvo no disco para o Yahoo)
let cacheMemoria = { cotacoes: {}, historico: {} };

// Cache Rápido (Memória RAM para APIs externas Brapi/Finnhub - expira em 5 min)
const cacheProxy = { brapi: {}, finnhub: {} };

// Recupera o banco de dados se existir
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

// ⏳ Função Auxiliar de Tempo para o Yahoo
function calcularDataInicio(range) {
    const data = new Date();
    if (range === '1mo') data.setMonth(data.getMonth() - 1);
    else if (range === '6mo') data.setMonth(data.getMonth() - 6);
    else if (range === '1y') data.setFullYear(data.getFullYear() - 1);
    else if (range === '5y') data.setFullYear(data.getFullYear() - 5);
    else data.setMonth(data.getMonth() - 1); 
    return data.toISOString().split('T')[0]; // Retorna YYYY-MM-DD
}

// ==========================================
// 🚀 3. ROTAS PRINCIPAIS (YAHOO E GEMINI)
// ==========================================

// ROTA A: Cotações em Lote (Fallback/Estepe do Yahoo)
app.get('/api/cotacoes-lote', async (req, res) => {
    const tickersStr = req.query.tickers; 
    if (!tickersStr) return res.json({});
    
    const tickers = tickersStr.split(',');
    const agora = Date.now();
    
    // Filtra apenas quem está com dado velho (mais de 5 min)
    const tickersParaAtualizar = tickers.filter(t => !cacheMemoria.cotacoes[t] || (agora - cacheMemoria.cotacoes[t].timestamp >= 300000));

    if (tickersParaAtualizar.length > 0) {
        console.log(`🔄 Servidor (Yahoo) solicitou ${tickersParaAtualizar.length} ativos faltantes. Fracionando...`);
        
        const TAMANHO_LOTE = 4;
        for (let i = 0; i < tickersParaAtualizar.length; i += TAMANHO_LOTE) {
            const subLote = tickersParaAtualizar.slice(i, i + TAMANHO_LOTE);
            
            try {
                const resultadosApi = await yahooFinance.quote(subLote);
                const resultadosArray = Array.isArray(resultadosApi) ? resultadosApi : [resultadosApi];

                resultadosArray.forEach(item => {
                    if (item && item.symbol) {
                        cacheMemoria.cotacoes[item.symbol] = {
                            timestamp: agora,
                            dados: {
                                ticker: item.symbol,
                                atual: item.regularMarketPrice,
                                fechamentoAnterior: item.regularMarketPreviousClose || item.regularMarketPrice
                            }
                        };
                    }
                });
                
                // Respiro anti-spam do Yahoo
                if (i + TAMANHO_LOTE < tickersParaAtualizar.length) {
                    await new Promise(resolve => setTimeout(resolve, 2500));
                }
            } catch (e) {
                console.log(`⚠️ Bloqueio 429 parcial. O Painel usará o Cache Local para o restante.`);
                break; // Para o loop e devolve o que tem
            }
        }
        salvarNoDisco();
    }

    // Monta a resposta com os dados atualizados ou do cache
    const respostaFinal = {};
    tickers.forEach(t => {
        if (cacheMemoria.cotacoes[t]) {
            respostaFinal[t] = cacheMemoria.cotacoes[t].dados;
        }
    });

    res.json(respostaFinal);
});

// ROTA B: Histórico para Gráficos Detalhados
app.get('/api/historico/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    const range = req.query.range || '1mo'; 
    const interval = req.query.interval || '1d';
    const chave = `${ticker}-${range}`; 
    const agora = Date.now();

    // Retorna do cache se tiver menos de 1 hora
    if (cacheMemoria.historico[chave] && (agora - cacheMemoria.historico[chave].timestamp < 3600000)) {
        return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
    }

    try {
        console.log(`📊 Baixando histórico de ${ticker} via YahooFinance2...`);
        const period1 = calcularDataInicio(range); 
        const period2 = new Date().toISOString().split('T')[0]; // Hoje (Evita erro de Legacy)
        
        // Usando .historical que é 100% seguro contra erros
        const result = await yahooFinance.historical(ticker, { period1: period1, period2: period2, interval: interval });
        
        const processados = result
            .filter(q => q.close !== null && !isNaN(q.close))
            .map(q => ({ 
                time: q.date.toISOString().split('T')[0], 
                close: parseFloat(q.close)
            }));
            
        cacheMemoria.historico[chave] = { timestamp: agora, dados: processados };
        salvarNoDisco();
        return res.json({ ticker: ticker, historico: processados });
    } catch (erro) { 
        console.log(`❌ Erro no gráfico de ${ticker}: ${erro.message}`); 
        if (cacheMemoria.historico[chave]) return res.json({ ticker: ticker, historico: cacheMemoria.historico[chave].dados });
        res.status(500).json({erro: `Erro ao buscar histórico.`}); 
    }
});

// ROTA C: ANÁLISE TÉCNICA ON-DEMAND (IA)
app.get('/api/analise-tecnica/:ticker', async (req, res) => {
    const ticker = req.params.ticker;
    console.log(`🎯 [IA] Gerando Análise Técnica em tempo real para: ${ticker}`);

    try {
        const period1 = calcularDataInicio('6mo'); 
        const period2 = new Date().toISOString().split('T')[0];
        
        const result = await yahooFinance.historical(ticker, { period1: period1, period2: period2, interval: '1d' });
        const processados = result.filter(q => q.close !== null && !isNaN(q.close));
        
        // Pega 1 em cada 3 dias para não estourar limite de texto do prompt
        const resumoPrecos = processados.filter((_, i) => i % 3 === 0).map(q => {
            return `${q.date.toISOString().split('T')[0]}: ${q.close.toFixed(2)}`;
        }).join(', ');

        const prompt = `Aja como um Analista Técnico de ações. Analise o histórico de preços dos últimos 6 meses da ação ${ticker}: [${resumoPrecos}]. 
        Determine a TENDÊNCIA atual (Alta, Baixa ou Lateral), identifique o SUPORTE mais relevante e a RESISTÊNCIA mais próxima. 
        Retorne APENAS um JSON no formato: {"ticker": "${ticker}", "tendencia": "...", "suporte": "...", "resistencia": "...", "comentario": "Resumo de 1 frase"}`;

        const resultado = await modeloIA.generateContent(prompt);
        const analiseIA = JSON.parse(resultado.response.text());

        res.json(analiseIA);

    } catch (erro) {
        console.error("❌ Erro na Análise Técnica:", erro.message);
        res.status(500).json({ erro: "Não foi possível gerar a análise agora." });
    }
});

// ==========================================
// 🌉 4. PROXYS DE ALTA DISPONIBILIDADE (BRAPI & FINNHUB)
// ==========================================

// Proxy Ações Brasil (Brapi) - Com Cache de 5 min
app.get('/api/brapi', async (req, res) => {
    const tickers = req.query.tickers;
    if (!tickers) return res.status(400).json({ erro: 'Tickers não informados' });

    const agora = Date.now();
    // 🧠 Retorna da memória se pediu recentemente
    if (cacheProxy.brapi[tickers] && (agora - cacheProxy.brapi[tickers].timestamp < 300000)) {
        return res.json(cacheProxy.brapi[tickers].dados);
    }

    try {
        const url = `https://brapi.dev/api/quote/${tickers}?token=${process.env.TOKEN_BRAPI}`;
        const response = await fetch(url);
        const data = await response.json();
        
        // Grava na memória RAM
        cacheProxy.brapi[tickers] = { timestamp: agora, dados: data };
        res.json(data);
    } catch (erro) {
        res.status(500).json({ erro: 'Falha ao buscar na Brapi' });
    }
});

// Proxy Ações Internacionais (Finnhub) - Com Cache e Freio ABS
app.get('/api/finnhub', async (req, res) => {
    const tickersStr = req.query.tickers;
    if (!tickersStr) return res.status(400).json({ erro: 'Tickers não informados' });
    
    const tickers = tickersStr.split(',');
    let resultados = [];
    const agora = Date.now();
    
    try {
        for (let t of tickers) {
            // 🧠 Se o ativo já está na memória, pega dali e pula a chamada da API
            if (cacheProxy.finnhub[t] && (agora - cacheProxy.finnhub[t].timestamp < 300000)) {
                resultados.push(cacheProxy.finnhub[t].dados);
                continue; 
            }

            const url = `https://finnhub.io/api/v1/quote?symbol=${t}&token=${process.env.TOKEN_FINNHUB}`;
            const response = await fetch(url);
            const data = await response.json();
            
            if (data && data.c) { 
                const itemFormatado = { symbol: t, price: data.c, previousClose: data.pc };
                resultados.push(itemFormatado);
                cacheProxy.finnhub[t] = { timestamp: agora, dados: itemFormatado };
            }
            
            // 🛑 FREIO ABS (300ms) - Evita bloqueio do Finnhub
            await new Promise(resolve => setTimeout(resolve, 300)); 
        }
        res.json(resultados);
    } catch (erro) {
        res.status(500).json({ erro: 'Falha ao buscar no Finnhub' });
    }
});

// ==========================================
// 🚀 INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, '0.0.0.0', () => console.log(`✅ Servidor HÍBRIDO BLINDADO na porta ${PORTA}!`));