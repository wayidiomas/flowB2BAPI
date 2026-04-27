// src/server.js
require("dotenv").config();
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");

// ===========================
// IMPORTAÇÕES MODERNIZADAS
// ===========================

// Configurações centralizadas
const { PORT } = require("./config");
const { CORS, ENV } = require("./config/SyncConfig");

// Logging estruturado
const { 
    logger, 
    requestLogger, 
    logOperationStart, 
    logOperationEnd 
} = require("./utils/logger");

// Rate limiting
const { createRateLimitMiddleware } = require("./utils/rateLimiter");

// Serviços
const { clearAllRenewalIntervals } = require("./services/blingTokenService");
const { getHealthCheck } = require("./services/metricsService");
const { blingQueueProcessor } = require("./services/blingQueueService");
const { registerHandlers: registerBlingHandlers } = require("./services/blingHandlers");

// Rotas
const syncRoutes = require("./routes/syncRoutes");
const queueRoutes = require("./routes/queueRoutes");

// ===========================
// INICIALIZAÇÃO DA APLICAÇÃO
// ===========================

const app = express();

logger.info('🚀 Iniciando FlowB2B API Server', {
    service: 'server',
    environment: ENV.IS_PRODUCTION ? 'production' : 'development',
    nodeVersion: process.version,
    port: PORT || 3000
});

// ===========================
// CORS MIDDLEWARE (CONFIGURAÇÕES CENTRALIZADAS)
// ===========================

app.use((req, res, next) => {
    // Usa configurações centralizadas do CORS
    const allowedOrigins = CORS.ALLOWED_ORIGINS;
    const origin = req.headers.origin;
    
    // Se permitir todas as origens ou se a origem está na lista
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.header('Access-Control-Allow-Methods', CORS.ALLOWED_METHODS.join(', '));
    res.header('Access-Control-Allow-Headers', CORS.ALLOWED_HEADERS.join(', '));
    res.header('Access-Control-Allow-Credentials', CORS.CREDENTIALS);
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(CORS.OPTIONS_SUCCESS_STATUS);
    }
    
    next();
});

logger.info('✅ CORS configurado', {
    service: 'server',
    allowedOrigins: CORS.ALLOWED_ORIGINS,
    allowedMethods: CORS.ALLOWED_METHODS
});

// ===========================
// MIDDLEWARES DE LOGGING
// ===========================

// Middleware de logging de requests
app.use(requestLogger);

logger.info('✅ Logging middleware configurado', {
    service: 'server'
});

// ===========================
// MIDDLEWARES DE RATE LIMITING
// ===========================

// Rate limiting global para todas as rotas da API
app.use('/api', createRateLimitMiddleware('api', 60)); // 60 requests por minuto

logger.info('✅ Rate limiting configurado', {
    service: 'server',
    globalLimit: '60 requests/min para /api/*'
});

// ===========================
// MIDDLEWARES BÁSICOS
// ===========================

// Middleware para aceitar JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===========================
// SWAGGER CONFIGURATION
// ===========================

const swaggerOptions = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "FlowB2B API",
            version: "2.0.0",
            description: "API modernizada para sincronização de dados do Bling e Supabase com logging estruturado, métricas em tempo real e rate limiting inteligente",
            contact: {
                name: "FlowB2B Team",
                email: "support@flowb2b.com"
            }
        },
        servers: [
            { 
                url: process.env.SERVER_URL || "http://localhost:3000",
                description: ENV.IS_PRODUCTION ? "Production Server" : "Development Server"
            }
        ],
        tags: [
            {
                name: "Sincronização",
                description: "Endpoints para sincronização de dados"
            },
            {
                name: "Monitoramento", 
                description: "Endpoints para monitoramento e métricas"
            },
            {
                name: "Sistema",
                description: "Endpoints de sistema e health check"
            }
        ]
    },
    apis: ["./src/routes/*.js"]
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs, {
    customSiteTitle: "FlowB2B API Documentation",
    customfavIcon: "/assets/favicon.ico",
    customCss: '.swagger-ui .topbar { display: none }'
}));

logger.info('✅ Swagger configurado', {
    service: 'server',
    docsUrl: '/api-docs'
});

// ===========================
// ROTAS PRINCIPAIS
// ===========================

app.use("/api/sync", syncRoutes);
app.use("/api/queue", queueRoutes);

// ===========================
// ROTAS DE SISTEMA E HEALTH CHECK
// ===========================

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check do sistema
 *     tags: [Sistema]
 *     responses:
 *       200:
 *         description: Sistema funcionando normalmente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: "healthy"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 uptime:
 *                   type: number
 *                   example: 86400
 *                 memory:
 *                   type: object
 *                   properties:
 *                     heapUsed:
 *                       type: number
 *                     heapTotal:
 *                       type: number
 *                     external:
 *                       type: number
 *                 activeSyncs:
 *                   type: number
 *                   example: 3
 */
app.get('/health', (req, res) => {
    try {
        const healthData = getHealthCheck();
        
        logger.debug('Health check solicitado', {
            service: 'server',
            ip: req.ip,
            userAgent: req.get('User-Agent')
        });
        
        res.json({
            ...healthData,
            server: {
                port: PORT || 3000,
                environment: ENV.IS_PRODUCTION ? 'production' : 'development',
                nodeVersion: process.version
            }
        });
    } catch (error) {
        logger.error('Erro no health check', {
            service: 'server',
            error: error.message
        });
        
        res.status(500).json({
            status: 'error',
            error: 'Health check failed',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * @swagger
 * /version:
 *   get:
 *     summary: Informações de versão da API
 *     tags: [Sistema]
 *     responses:
 *       200:
 *         description: Informações de versão
 */
app.get('/version', (req, res) => {
    res.json({
        name: "FlowB2B API",
        version: "2.0.0",
        description: "API modernizada com logging estruturado e métricas",
        environment: ENV.IS_PRODUCTION ? 'production' : 'development',
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
    });
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        message: "🚀 FlowB2B API está funcionando!",
        version: "2.0.0",
        documentation: "/api-docs",
        health: "/health",
        timestamp: new Date().toISOString()
    });
});

logger.info('✅ Rotas de sistema configuradas', {
    service: 'server',
    routes: ['/', '/health', '/version', '/api-docs']
});

// ===========================
// MIDDLEWARE DE ERRO GLOBAL
// ===========================

app.use((error, req, res, next) => {
    logger.error('Erro não tratado na aplicação', {
        service: 'server',
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip
    });
    
    res.status(500).json({
        success: false,
        error: ENV.IS_PRODUCTION ? 'Internal Server Error' : error.message,
        timestamp: new Date().toISOString()
    });
});

// Middleware para rotas não encontradas
app.use('*', (req, res) => {
    logger.warn('Rota não encontrada', {
        service: 'server',
        url: req.originalUrl,
        method: req.method,
        ip: req.ip
    });
    
    res.status(404).json({
        success: false,
        error: 'Route not found',
        message: `Cannot ${req.method} ${req.originalUrl}`,
        availableRoutes: {
            docs: '/api-docs',
            health: '/health',
            version: '/version',
            sync: '/api/sync/*'
        },
        timestamp: new Date().toISOString()
    });
});

// ===========================
// TRATAMENTO DE ENCERRAMENTO LIMPO
// ===========================

function gracefulShutdown(signal) {
    logger.info(`🛑 ${signal} recebido. Iniciando encerramento limpo...`, {
        service: 'server',
        signal
    });
    
    logOperationStart('server-shutdown', { signal });
    
    // Para de aceitar novas conexões
    server.close((err) => {
        if (err) {
            logger.error('Erro ao fechar servidor', {
                service: 'server',
                error: err.message
            });
        } else {
            logger.info('✅ Servidor HTTP fechado', {
                service: 'server'
            });
        }
        
        // Limpa intervalos de renovação de token
        try {
            clearAllRenewalIntervals();
            logger.info('✅ Intervalos de renovação de token limpos', {
                service: 'server'
            });
        } catch (error) {
            logger.error('Erro ao limpar intervalos de token', {
                service: 'server',
                error: error.message
            });
        }

        // Para o worker da fila Bling
        try {
            blingQueueProcessor.stop();
            logger.info('✅ Worker da fila Bling parado', {
                service: 'server'
            });
        } catch (error) {
            logger.error('Erro ao parar worker da fila Bling', {
                service: 'server',
                error: error.message
            });
        }
        
        logOperationEnd('server-shutdown', true, { signal });
        
        logger.info('🏁 Encerramento limpo concluído', {
            service: 'server',
            signal
        });
        
        process.exit(0);
    });
    
    // Force close após 10 segundos
    setTimeout(() => {
        logger.error('⚠️ Forçando encerramento após timeout', {
            service: 'server',
            signal
        });
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===========================
// TRATAMENTO DE ERROS NÃO CAPTURADOS
// ===========================

process.on('uncaughtException', (error) => {
    logger.error('❌ Exceção não capturada', {
        service: 'server',
        error: error.message,
        stack: error.stack
    });
    
    clearAllRenewalIntervals();
    
    server.close(() => {
        process.exit(1);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('❌ Rejeição não tratada', {
        service: 'server',
        reason: reason?.message || reason,
        stack: reason?.stack
    });
    
    clearAllRenewalIntervals();
    
    server.close(() => {
        process.exit(1);
    });
});

// ===========================
// INICIALIZAÇÃO DO SERVIDOR
// ===========================

const port = PORT || 3000;

const server = app.listen(port, () => {
    const serverInfo = {
        port,
        environment: ENV.IS_PRODUCTION ? 'production' : 'development',
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString()
    };
    
    logOperationStart('server-startup', serverInfo);
    
    logger.info('🎉 FlowB2B API Server iniciado com sucesso!', {
        service: 'server',
        ...serverInfo,
        urls: {
            server: process.env.SERVER_URL || `http://localhost:${port}`,
            docs: `${process.env.SERVER_URL || `http://localhost:${port}`}/api-docs`,
            health: `${process.env.SERVER_URL || `http://localhost:${port}`}/health`
        }
    });
    
    console.log(`\n🚀 FlowB2B API Server running on port ${port}`);
    console.log(`📜 Documentation: ${process.env.SERVER_URL || `http://localhost:${port}`}/api-docs`);
    console.log(`💚 Health Check: ${process.env.SERVER_URL || `http://localhost:${port}`}/health`);
    console.log(`🔧 Environment: ${ENV.IS_PRODUCTION ? 'production' : 'development'}\n`);

    // Registra handlers da fila Bling antes de iniciar o worker
    try {
        registerBlingHandlers();
        blingQueueProcessor.start();
        logger.info('✅ Worker da fila Bling iniciado', { service: 'server' });
    } catch (error) {
        logger.error('Erro ao iniciar worker da fila Bling', {
            service: 'server',
            error: error.message
        });
    }

    logOperationEnd('server-startup', true, serverInfo);
});

// ===========================
// EXPORTAÇÃO (para testes)
// ===========================

module.exports = app;