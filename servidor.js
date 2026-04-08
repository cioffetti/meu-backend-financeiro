import 'dotenv/config';
import YahooFinance from 'yahoo-finance2';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. LIGANDO AS MÁQUINAS
const CHAVE_GEMINI = process.env.CHAVE_GEMINI;
const genAI = new GoogleGenerativeAI(CHAVE_GEMINI);

const modeloIA = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// 2. LISTAS DE TRABALHO
const listaBrasil = ['AGRO3.SA', 'AMOB3.SA', 'BBAS3.SA', 'BBDC3.SA', 'BBSE3.SA', 'BRSR6.SA', 'B3SA3.SA', 'CMIG3.SA', 'CXSE3.SA', 'EGIE3.SA', 'EQTL3.SA', 'ETHE11.SA', 'EZTC3.SA', 'FLRY3.SA', 'GMAT3.SA', 'GOLD11.SA', 'ITSA4.SA', 'KEPL3.SA', 'KLBN3.SA', 'LEVE3.SA', 'MBRF3.SA', 'PETR3.SA', 'PRIO3.SA', 'PSSA3.SA', 'QBTC11.SA', 'QSOL11.SA', 'RAIZ4.SA', 'RANI3.SA', 'SAPR4.SA', 'SBFG3.SA', 'SMTO3.SA', 'SOJA3.SA', 'SUZB3.SA', 'TAEE11.SA', 'TTEN3.SA', 'VAMO3.SA', 'VIVT3.SA', 'WEGE3.SA'];
const listaIntl = ['GOOGL', 'AMZN', 'NVDA', 'TSM', 'ASML', 'AVGO', 'IRS', 'TSLA', 'MU', 'VZ', 'T', 'HD', 'SHOP', 'DIS', 'SPG', 'ANET', 'ICE', 'KO', 'EQNR', 'EPR', 'WFC', 'VICI', 'O', 'CPRT', 'ASX', 'CEPU', 'NVO', 'PLTR', 'JBL', 'QCOM', 'AAPL', 'MSFT', 'BAC', 'ORCL', 'EQT', 'MNST', 'CVS', 'HUYA', 'GPC', 'PFE', 'ROKU', 'DIBS', 'LEG', 'MBUU', 'FVRR'];
const todasAsAcoes = [...listaBrasil, ...listaIntl];
const ativosSemValuation = ['ETHE11.SA', 'QBTC11.SA', 'QSOL11.SA', 'GOLD11.SA'];

// 3. CONFIGURAÇÕES DO ARQUITETO
const LIMITE_DIARIO_IA = 20; // Máximo de perguntas por dia para não ser bloqueado
const DIAS_DE_VALIDADE = 15; // 🚦 MODO PILOTO AUTOMÁTICO DE LONGO PRAZO ATIVADO!

let bancoAntigo = {};
if (fs.existsSync('indicadores.json')) {
    try { bancoAntigo = JSON.parse(fs.readFileSync('indicadores.json', 'utf-8')); } catch (e) { }
}

function extrairMatematica(result) {
    const getVal = (obj, path) => path.split('.').reduce((acc, part) => acc && acc[part], obj)?.raw || null;
    return {
        precoAtual: getVal(result, 'financialData.currentPrice') || result.summaryDetail?.previousClose || 0,
        pl: getVal(result, 'summaryDetail.trailingPE') || result.summaryDetail?.trailingPE, 
        pvp: getVal(result, 'defaultKeyStatistics.priceToBook') || result.defaultKeyStatistics?.priceToBook,        dy: getVal(result, 'summaryDetail.dividendYield') || result.summaryDetail?.dividendYield,
        pegRatio: getVal(result, 'defaultKeyStatistics.pegRatio') || result.defaultKeyStatistics?.pegRatio, 
        evEbitda: getVal(result, 'defaultKeyStatistics.enterpriseToEbitda') || result.defaultKeyStatistics?.enterpriseToEbitda, 
        vpa: getVal(result, 'defaultKeyStatistics.bookValue') || result.defaultKeyStatistics?.bookValue,
        lpa: getVal(result, 'defaultKeyStatistics.trailingEps') || result.defaultKeyStatistics?.trailingEps, 
        psr: getVal(result, 'summaryDetail.priceToSalesTrailing12Months') || result.summaryDetail?.priceToSalesTrailing12Months, 
        roe: getVal(result, 'financialData.returnOnEquity') || result.financialData?.returnOnEquity,
        roa: getVal(result, 'financialData.returnOnAssets') || result.financialData?.returnOnAssets, 
        margemBruta: getVal(result, 'financialData.grossMargins') || result.financialData?.grossMargins, 
        margemOperacional: getVal(result, 'financialData.operatingMargins') || result.financialData?.operatingMargins,
        margemLiquida: getVal(result, 'financialData.profitMargins') || result.financialData?.profitMargins, 
        dividaPL: getVal(result, 'financialData.debtToEquity') || result.financialData?.debtToEquity, 
        liquidezCorrente: getVal(result, 'financialData.currentRatio') || result.financialData?.currentRatio
    };
}

// MÁGICA DO TEMPO: Calcula quantos dias se passaram
function calcularDiasPassados(dataString) {
    if (!dataString) return 999; 
    const partes = dataString.split('/');
    if (partes.length !== 3) return 999;
    const dataAntiga = new Date(partes[2], partes[1] - 1, partes[0]);
    const hoje = new Date();
    const diffTempo = Math.abs(hoje - dataAntiga);
    return Math.floor(diffTempo / (1000 * 60 * 60 * 24));
}

async function gerarAnaliseComIA(ticker, dadosMatematicos, isETF) {
    const prompt = `Você é um Analista de Investimentos Sênior. Gere a análise para a empresa ${ticker} baseada nestes indicadores reais: 
    Preço Atual de Tela: ${dadosMatematicos.precoAtual}
    P/L: ${dadosMatematicos.pl}, ROE: ${dadosMatematicos.roe}, Margem Líquida: ${dadosMatematicos.margemLiquida}. 
    
    IMPORTANTE: Calcule valores REAIS e coerentes para o Preço Justo nos cenários com base no Preço Atual e nos fundamentos da empresa. NÃO copie os valores zerados de exemplo.
    
    Retorne o JSON estrito obedecendo o esquema: { "analise_senior": { "tendencia": "texto", "swot": { "forcas": "...", "fraquezas": "...", "oportunidades": "...", "ameacas": "..." }, "notas": { "roe": 4, "roic": 3, "ebitda": 5, "divida": 2, "receita": 4 } } ${!isETF ? `, "valuation_dcf": { "parametros": { "wacc": "12%", "crescimento_longo_prazo": "2%", "margem_seguranca": "20%" }, "status": "JUSTO", "cenarios": { "pessimista": { "preco_justo": 0.00, "descricao": "..." }, "base": { "preco_justo": 0.00, "descricao": "..." }, "otimista": { "preco_justo": 0.00, "descricao": "..." } } }` : ''} }`;
    
    try {
        const resultado = await modeloIA.generateContent(prompt);
        return JSON.parse(resultado.response.text());
    } catch (erro) { 
        console.error(`   🔎 Detalhe do bloqueio: ${erro.message}`);
        return null; 
    }
}

async function iniciarTrabalho() {
    console.log("🤖 Iniciando 'Motor de Cache Rotativo' (Modo Piloto Automático)...\n");
    
    const bancoDeDadosJSON = {};
    const dataHoje = new Date().toLocaleDateString('pt-BR'); 
    let perguntasIADia = 0; 

    for (const ticker of todasAsAcoes) {
        try {
            console.log(`⏳ [${ticker}] Baixando números matemáticos do Yahoo...`);
            const resultYahoo = await yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData'] });
            const matematica = extrairMatematica(resultYahoo);
            const isETF = ativosSemValuation.includes(ticker);
            
            const diasPassados = calcularDiasPassados(bancoAntigo[ticker]?.data_referencia);
            
            // Lógica PADRÃO do escudo protetor (Sem amnésia forçada)
            let temAnaliseValida = diasPassados <= DIAS_DE_VALIDADE && 
                                     bancoAntigo[ticker]?.analise_senior?.tendencia && 
                                     bancoAntigo[ticker]?.analise_senior?.tendencia !== "Aguardando análise do especialista...";

            let analiseFinal = null;
            let valuationFinal = null;
            let dataSalvar = bancoAntigo[ticker]?.data_referencia || dataHoje; 

            if (temAnaliseValida) {
                console.log(`   ⏭️ Poupando cota! Análise tem ${diasPassados} dias (válida por ${DIAS_DE_VALIDADE} dias).`);
                analiseFinal = bancoAntigo[ticker].analise_senior;
                valuationFinal = bancoAntigo[ticker].valuation_dcf;
            } else if (perguntasIADia < LIMITE_DIARIO_IA && !isETF) { 
                console.log(`   🧠 Solicitando IA (Consulta ${perguntasIADia + 1} de ${LIMITE_DIARIO_IA})...`);
                
                let tentativas = 0;
                let analiseIA = null;

                while (tentativas < 3 && !analiseIA) {
                    analiseIA = await gerarAnaliseComIA(ticker, matematica, isETF);
                    
                    if (!analiseIA) {
                        tentativas++;
                        if (tentativas < 3) {
                            console.log(`   🚧 Bloqueio detectado! Tentativa ${tentativas} falhou. Esperando 60s para tentar de novo...`);
                            await new Promise(r => setTimeout(r, 60000));
                        }
                    }
                }

                if (analiseIA) {
                    analiseFinal = analiseIA.analise_senior;
                    valuationFinal = analiseIA.valuation_dcf;
                    dataSalvar = dataHoje; 
                    perguntasIADia++;
                    console.log(`   ✅ Tese e Valuation concluídos!`);
                } else {
                    console.log(`   ❌ Falha definitiva na IA após 3 tentativas. Pulando ativo.`);
                    analiseFinal = bancoAntigo[ticker]?.analise_senior || { tendencia: "Aguardando análise do especialista...", swot: { forcas: "-", fraquezas: "-", oportunidades: "-", ameacas: "-" }, notas: { roe: 0, roic: 0, ebitda: 0, divida: 0, receita: 0 } };
                    valuationFinal = bancoAntigo[ticker]?.valuation_dcf || null;
                }

                console.log(`   ⏳ Esfriando motores por 25s para a próxima ação...`);
                await new Promise(r => setTimeout(r, 25000));

            } else {
                if (isETF) {
                    console.log(`   🚫 ETF detectado. Valuation não aplicável.`);
                } else {
                    console.log(`   ⏸️ Cota diária atingida. Retendo texto antigo para atualizar amanhã.`);
                }
                analiseFinal = bancoAntigo[ticker]?.analise_senior || { tendencia: "Aguardando análise do especialista...", swot: { forcas: "-", fraquezas: "-", oportunidades: "-", ameacas: "-" }, notas: { roe: 0, roic: 0, ebitda: 0, divida: 0, receita: 0 } };
                valuationFinal = bancoAntigo[ticker]?.valuation_dcf || null;
            }

            bancoDeDadosJSON[ticker] = {
                ...matematica,
                data_referencia: dataSalvar,
                analise_senior: analiseFinal,
                valuation_dcf: valuationFinal
            };

            console.log("--------------------------------------------------");
        } catch (erro) { 
            console.error(`   ⚠️ Erro de rede no Yahoo para ${ticker}.\n`); 
            bancoDeDadosJSON[ticker] = bancoAntigo[ticker] || {};
        }
    }

    fs.writeFileSync('indicadores.json', JSON.stringify(bancoDeDadosJSON, null, 2), 'utf-8');
    console.log("\n🎉 SUCESSO! Banco de dados atualizado com Cache Rotativo Inteligente.");
}

iniciarTrabalho();