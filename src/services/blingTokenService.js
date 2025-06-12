// src/services/blingTokenService.js - VERSÃO COMPLETAMENTE CORRIGIDA
const axios = require("axios");
const FormData = require("form-data");
const supabase = require("./supabaseService");
const { TOKEN } = require("../config/SyncConfig");
const { 
  createTokenContext, 
  logError, 
  logOperationStart, 
  logOperationEnd,
  sanitizeData 
} = require("../utils/logger");
const { 
  waitForToken, 
  rateLimiterManager,
  withBlingRateLimit 
} = require("../utils/rateLimiter");

// ===========================
// CONSTANTES DE CONFIGURAÇÃO
// ===========================
const MUTEX_TIMEOUT = 30000; // 30 segundos
const DATE_COMPARISON_TOLERANCE = 5000; // 5 segundos de tolerância para timezone
const RENEWAL_GRACE_PERIOD = 60000; // 1 minuto mínimo para próxima renovação

class TokenManager {
    constructor() {
        this.renewalIntervals = new Map();
        this.renewalMutex = new Map(); // Previne renovações concorrentes
        this.mutexTimers = new Map(); // Timers para limpar mutex travados
        
        // Usa configurações centralizadas
        this.TOKEN_RENEWAL_INTERVAL = TOKEN.RENEWAL_INTERVAL;
        this.TOKEN_EXPIRATION_BUFFER = TOKEN.EXPIRATION_BUFFER;
        this.REQUEST_TIMEOUT = TOKEN.REQUEST_TIMEOUT;
        
        // Estatísticas do token manager
        this.stats = {
            totalRenewals: 0,
            successfulRenewals: 0,
            failedRenewals: 0,
            averageRenewalTime: 0,
            lastRenewalTime: null,
            mutexTimeouts: 0,
            mutexClears: 0,
            autoCleanups: 0
        };

        // Logger contexto para tokens
        this.logger = createTokenContext('system');
        
        this.logger.info('Token Manager inicializado', {
            renewalInterval: `${this.TOKEN_RENEWAL_INTERVAL}ms`,
            expirationBuffer: `${this.TOKEN_EXPIRATION_BUFFER}ms`,
            timeout: `${this.REQUEST_TIMEOUT}ms`,
            mutexTimeout: `${MUTEX_TIMEOUT}ms`
        });

        // Inicia limpeza automática de mutex travados
        this._startMutexCleanupTimer();
    }

    /**
     * ✅ FUNÇÃO PRINCIPAL CORRIGIDA: Obtém token válido com controle robusto de concorrência
     */
    async getValidToken(empresa_id, accessToken = null, refresh_token = null) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        logger.debug('getValidToken chamado', {
            operation: 'getValidToken',
            hasAccessToken: !!accessToken,
            hasRefreshToken: !!refresh_token,
            mutexExists: this.renewalMutex.has(key),
            activeRenewals: this.renewalIntervals.size
        });
        
        // ✅ PROTEÇÃO MELHORADA: Timeout para mutex travado
        if (this.renewalMutex.has(key)) {
            logger.info('Aguardando renovação em progresso', {
                operation: 'getValidToken',
                status: 'waiting'
            });
            
            try {
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Mutex timeout - possível deadlock')), MUTEX_TIMEOUT);
                });
                
                await Promise.race([mutexPromise, timeoutPromise]);
                
                // ✅ PÓS-MUTEX: Busca token atualizado do banco
                const updatedToken = await this._getTokenFromDB(empresa_id);
                if (updatedToken?.access_token && this._isTokenValid(updatedToken)) {
                    logger.debug('Token válido obtido após aguardar mutex', {
                        operation: 'getValidToken',
                        tokenPreview: `${updatedToken.access_token.substring(0, 8)}***`
                    });
                    
                    this._ensureRenewalScheduled(empresa_id, updatedToken);
                    return updatedToken.access_token;
                }
                
            } catch (error) {
                logger.warn('Mutex timeout ou erro, removendo mutex travado', {
                    operation: 'getValidToken',
                    error: error.message,
                    mutexKey: key
                });
                
                this._clearMutex(key);
                this.stats.mutexTimeouts++;
            }
        }

        try {
            const tokenData = await this._getTokenFromDB(empresa_id);
            
            logger.debug('Token lido do banco', {
                operation: 'getValidToken',
                hasToken: !!tokenData,
                expiresAt: tokenData?.expires_at,
                tokenPreview: tokenData?.access_token ? `${tokenData.access_token.substring(0, 8)}***` : null
            });
            
            if (!tokenData || !tokenData.expires_at) {
                logger.warn('Token não encontrado ou sem data de expiração', {
                    hasToken: !!tokenData,
                    hasExpiresAt: !!tokenData?.expires_at
                });
                
                return await this._renewToken(empresa_id, refresh_token || tokenData?.refresh_token);
            }

            // ✅ VALIDAÇÃO MELHORADA: Verifica se token é válido
            if (!this._isTokenValid(tokenData)) {
                const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
                const minutesUntilExpiry = Math.round(timeUntilExpiry / 1000 / 60);
                
                logger.info('Token próximo do vencimento, renovando', {
                    operation: 'getValidToken',
                    minutesUntilExpiry,
                    expiresAt: tokenData.expires_at
                });
                
                return await this._renewToken(empresa_id, tokenData.refresh_token);
            }

            // ✅ AGENDAMENTO: Garante que renovação está agendada
            this._ensureRenewalScheduled(empresa_id, tokenData);
            
            const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
            logger.debug('Token válido obtido', {
                operation: 'getValidToken',
                minutesUntilExpiry: Math.round(timeUntilExpiry / 1000 / 60),
                tokenPreview: `${tokenData.access_token.substring(0, 8)}***`
            });
            
            return tokenData.access_token;
            
        } catch (error) {
            logError(error, 'getValidToken', { empresa_id });
            throw error;
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Verifica se token é válido com tratamento de erro
     */
    _isTokenValid(tokenData) {
        if (!tokenData?.expires_at) {
            return false;
        }
        
        try {
            const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
            const isValid = timeUntilExpiry > this.TOKEN_EXPIRATION_BUFFER;
            
            // Log de debug para troubleshooting
            if (!isValid) {
                const logger = createTokenContext('system');
                logger.debug('Token inválido detectado', {
                    operation: 'isTokenValid',
                    expiresAt: tokenData.expires_at,
                    timeUntilExpiry: `${Math.round(timeUntilExpiry / 1000)}s`,
                    bufferRequired: `${Math.round(this.TOKEN_EXPIRATION_BUFFER / 1000)}s`
                });
            }
            
            return isValid;
        } catch (error) {
            // Se houver erro na validação, considera inválido
            const logger = createTokenContext('system');
            logger.warn('Erro na validação de token', {
                operation: 'isTokenValid',
                error: error.message,
                expiresAt: tokenData.expires_at
            });
            return false;
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Calcula tempo até expiração com validação
     */
    _getTimeUntilExpiry(expiresAt) {
        try {
            const expirationDate = new Date(expiresAt);
            
            // Verifica se a data é válida
            if (isNaN(expirationDate.getTime())) {
                throw new Error(`Data de expiração inválida: ${expiresAt}`);
            }
            
            const timeUntilExpiry = expirationDate.getTime() - Date.now();
            return timeUntilExpiry;
        } catch (error) {
            const logger = createTokenContext('system');
            logger.error('Erro ao calcular tempo até expiração', {
                operation: 'getTimeUntilExpiry',
                expiresAt,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Garante que renovação está agendada
     */
    _ensureRenewalScheduled(empresa_id, tokenData) {
        if (!this.renewalIntervals.has(empresa_id)) {
            try {
                const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
                
                if (timeUntilExpiry > this.TOKEN_EXPIRATION_BUFFER) {
                    this._scheduleRenewal(empresa_id, tokenData.refresh_token, timeUntilExpiry);
                }
            } catch (error) {
                const logger = createTokenContext(empresa_id);
                logger.warn('Erro ao agendar renovação', {
                    operation: 'ensureRenewalScheduled',
                    error: error.message
                });
            }
        }
    }

    /**
     * ✅ FUNÇÃO MELHORADA: Renova token com mutex robusto
     */
    async _renewToken(empresa_id, refresh_token) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        logger.debug('_renewToken chamado', {
            operation: 'renewToken',
            hasRefreshToken: !!refresh_token,
            mutexExists: this.renewalMutex.has(key)
        });
        
        // Se já está renovando, aguarda COM TIMEOUT
        if (this.renewalMutex.has(key)) {
            logger.debug('Aguardando renovação já em progresso');
            
            try {
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Renewal mutex timeout')), MUTEX_TIMEOUT);
                });
                
                const result = await Promise.race([mutexPromise, timeoutPromise]);
                return result.access_token;
                
            } catch (error) {
                logger.warn('Timeout em mutex de renovação, removendo', {
                    operation: 'renewToken',
                    error: error.message
                });
                
                this._clearMutex(key);
                this.stats.mutexTimeouts++;
            }
        }

        // Cria mutex com timeout automático
        const renewalPromise = this._performRenewal(empresa_id, refresh_token);
        this._setMutex(key, renewalPromise);
        
        // Registra no rate limiter para controle de concorrência
        rateLimiterManager.startTokenRenewal(empresa_id, renewalPromise);

        try {
            const result = await renewalPromise;
            return result.access_token;
        } catch (error) {
            logger.error('Erro na renovação de token', {
                operation: 'renewToken',
                error: error.message
            });
            throw error;
        } finally {
            this._clearMutex(key);
            this.stats.mutexClears++;
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Define mutex com timeout automático
     */
    _setMutex(key, promise) {
        this.renewalMutex.set(key, promise);
        
        // ✅ PROTEÇÃO: Timer para limpar mutex automaticamente
        const timer = setTimeout(() => {
            if (this.renewalMutex.has(key)) {
                this.logger.warn('Limpando mutex travado automaticamente', { 
                    key,
                    timeoutMs: MUTEX_TIMEOUT * 2 
                });
                this._clearMutex(key);
                this.stats.autoCleanups++;
            }
        }, MUTEX_TIMEOUT * 2); // Dobro do timeout normal
        
        // ✅ CORREÇÃO: Adiciona timestamp para controle
        timer.created = Date.now();
        this.mutexTimers.set(key, timer);
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Limpa mutex e timer associado
     */
    _clearMutex(key) {
        this.renewalMutex.delete(key);
        
        if (this.mutexTimers.has(key)) {
            clearTimeout(this.mutexTimers.get(key));
            this.mutexTimers.delete(key);
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Inicia timer de limpeza automática
     */
    _startMutexCleanupTimer() {
        setInterval(() => {
            const now = Date.now();
            let cleanedMutex = 0;
            
            for (const [key, timer] of this.mutexTimers.entries()) {
                // ✅ CORREÇÃO: Verifica se timer.created existe antes de usar
                const timerAge = timer.created ? (now - timer.created) : 0;
                
                // Se o timer foi criado há mais de 5 minutos, força limpeza
                if (timerAge > 300000) { // 5 minutos
                    this.logger.warn('Limpeza automática de mutex muito antigo', { 
                        key,
                        timerAge: `${Math.round(timerAge / 1000)}s`
                    });
                    this._clearMutex(key);
                    cleanedMutex++;
                }
            }
            
            if (cleanedMutex > 0) {
                this.stats.autoCleanups += cleanedMutex;
                this.logger.info('Limpeza automática de mutex concluída', { 
                    cleanedMutex,
                    totalAutoCleanups: this.stats.autoCleanups 
                });
            }
        }, 60000); // A cada 1 minuto
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Executa renovação com melhor tratamento de erros
     */
    async _performRenewal(empresa_id, refresh_token) {
        const logger = createTokenContext(empresa_id);
        const startTime = Date.now();
        
        logOperationStart('tokenRenewal', { 
            empresa_id,
            refreshTokenPreview: refresh_token ? `${refresh_token.substring(0, 8)}***` : null
        });

        try {
            // Aplica rate limiting antes da renovação
            await waitForToken(empresa_id);
            
            logger.info('Iniciando renovação de token', {
                operation: 'performRenewal'
            });

            // Wrapper com rate limiting do Bling
            const result = await withBlingRateLimit(async () => {
                const formData = new FormData();
                formData.append("grant_type", "refresh_token");
                formData.append("refresh_token", refresh_token);

                const response = await axios.post(
                    "https://www.bling.com.br/Api/v3/oauth/token",
                    formData,
                    {
                        headers: {
                            ...formData.getHeaders(),
                            ...TOKEN.DEFAULT_HEADERS,
                            Authorization: `Basic ${process.env.BLING_AUTHORIZATION}`,
                        },
                        timeout: this.REQUEST_TIMEOUT
                    }
                );

                return response.data;
            });

            const { access_token, refresh_token: new_refresh_token, expires_in } = result;
            const expires_at = new Date(Date.now() + expires_in * 1000);

            logger.debug('Resposta do Bling recebida', {
                operation: 'performRenewal',
                expires_in,
                expires_at: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`
            });

            // ✅ SALVA: No banco com validação melhorada
            await this._saveTokenToDB(empresa_id, access_token, new_refresh_token, expires_at);

            // ✅ AGENDAMENTO: Usa timeUntilExpiry correto
            const timeUntilExpiry = expires_at.getTime() - Date.now();
            this._scheduleRenewal(empresa_id, new_refresh_token, timeUntilExpiry);

            // Atualiza estatísticas
            const renewalTime = Date.now() - startTime;
            this._updateStats(true, renewalTime);

            const tokenResult = { access_token, refresh_token: new_refresh_token, expires_at };
            
            logOperationEnd('tokenRenewal', true, {
                empresa_id,
                renewalTime: `${renewalTime}ms`,
                expiresAt: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`,
                expires_in
            });

            logger.info('Token renovado com sucesso', {
                operation: 'performRenewal',
                renewalTime: `${renewalTime}ms`,
                expiresIn: `${expires_in}s`,
                expiresAt: expires_at.toISOString()
            });

            return tokenResult;

        } catch (error) {
            // Atualiza estatísticas de erro
            const renewalTime = Date.now() - startTime;
            this._updateStats(false, renewalTime);

            logOperationEnd('tokenRenewal', false, {
                empresa_id,
                renewalTime: `${renewalTime}ms`,
                error: error.message
            });

            logError(error, 'performRenewal', { 
                empresa_id,
                refreshTokenProvided: !!refresh_token
            });

            throw error;
        }
    }

    /**
     * ✅ FUNÇÃO MELHORADA: Agenda renovação com validações robustas
     */
    _scheduleRenewal(empresa_id, refresh_token, timeUntilExpiry) {
        const logger = createTokenContext(empresa_id);
        
        const debugInfo = {
            empresa_id,
            timeUntilExpiry,
            timeUntilExpiryMinutes: Math.round(timeUntilExpiry / 1000 / 60),
            expirationBuffer: this.TOKEN_EXPIRATION_BUFFER,
            expirationBufferMinutes: Math.round(this.TOKEN_EXPIRATION_BUFFER / 1000 / 60),
            currentTime: new Date().toISOString()
        };
        
        logger.debug('_scheduleRenewal chamado', {
            operation: 'scheduleRenewal',
            ...debugInfo
        });
        
        // ✅ VALIDAÇÃO ROBUSTA: Verifica se timeUntilExpiry é válido
        if (!timeUntilExpiry || timeUntilExpiry <= 0 || !isFinite(timeUntilExpiry)) {
            logger.error('timeUntilExpiry inválido, não agendando renovação', {
                operation: 'scheduleRenewal',
                timeUntilExpiry,
                debugInfo
            });
            return;
        }
        
        // Limpa agendamento anterior
        this.clearRenewal(empresa_id);

        // ✅ CÁLCULO MELHORADO: Agenda para antes de expirar com grace period
        const renewalTime = Math.max(
            timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 
            RENEWAL_GRACE_PERIOD
        );
        const renewalMinutes = Math.round(renewalTime / 1000 / 60);
        const renewalAt = new Date(Date.now() + renewalTime);
        
        logger.debug('Cálculo de agendamento', {
            operation: 'scheduleRenewal',
            renewalTime,
            renewalMinutes,
            renewalAt: renewalAt.toISOString(),
            calculation: {
                step1_timeUntilExpiry: timeUntilExpiry,
                step2_minusBuffer: timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER,
                step3_maxWithGrace: Math.max(timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, RENEWAL_GRACE_PERIOD),
                step4_finalTimestamp: Date.now() + renewalTime
            }
        });
        
        logger.info('Agendando renovação automática', {
            operation: 'scheduleRenewal',
            renewalInMinutes: renewalMinutes,
            renewalAt: renewalAt.toISOString()
        });
        
        const intervalId = setTimeout(async () => {
            const scheduleLogger = createTokenContext(empresa_id);
            
            try {
                scheduleLogger.info('Executando renovação agendada', {
                    scheduledFor: renewalAt.toISOString(),
                    actualTime: new Date().toISOString()
                });
                await this._renewToken(empresa_id, refresh_token);
            } catch (error) {
                logError(error, 'scheduledRenewal', { empresa_id });
                
                // Remove da lista se falhou
                this.clearRenewal(empresa_id);
            }
        }, renewalTime);

        this.renewalIntervals.set(empresa_id, intervalId);
        
        logger.debug('Renovação agendada com sucesso', {
            operation: 'scheduleRenewal',
            intervalId: intervalId.toString().substring(0, 10) + '...',
            activeRenewals: this.renewalIntervals.size
        });
    }

    /**
     * ✅ FUNÇÃO COMPLETAMENTE CORRIGIDA: Salva token com normalização de timezone
     */
    async _saveTokenToDB(empresa_id, access_token, refresh_token, expires_at) {
        const logger = createTokenContext(empresa_id);
        
        try {
            // ✅ NORMALIZAÇÃO: Converte para timestamp UTC consistente
            const normalizedExpiresAt = new Date(expires_at).toISOString();
            
            logger.debug('Salvando token no banco', {
                operation: 'saveTokenToDB',
                expiresAt: normalizedExpiresAt,
                tokenPreview: `${access_token.substring(0, 8)}***`
            });
            
            const { data, error } = await supabase.from("bling_tokens").upsert(
                {
                    empresa_id,
                    access_token,
                    refresh_token,
                    expires_at: normalizedExpiresAt, // ✅ USA DATA NORMALIZADA
                    updated_at: new Date().toISOString()
                },
                { 
                    onConflict: ["empresa_id"],
                    returning: "minimal"
                }
            );

            if (error) throw error;
            
            // ✅ VALIDAÇÃO MELHORADA: Compara timestamps numericamente
            const savedToken = await this._getTokenFromDB(empresa_id);
            if (!savedToken) {
                throw new Error('Token não foi encontrado após salvamento');
            }
            
            // ✅ COMPARAÇÃO ROBUSTA: Converte ambas as datas para timestamp
            const expectedTime = new Date(expires_at).getTime();
            const savedTime = new Date(savedToken.expires_at).getTime();
            const timeDiff = Math.abs(expectedTime - savedTime);
            
            // ✅ TOLERÂNCIA AUMENTADA: Aceita diferenças menores que 5 segundos
            if (timeDiff > DATE_COMPARISON_TOLERANCE) {
                throw new Error(`Token timestamp inválido: diferença de ${timeDiff}ms excede tolerância de ${DATE_COMPARISON_TOLERANCE}ms`);
            }
            
            logger.debug('Token salvo e validado com sucesso', {
                operation: 'saveTokenToDB',
                expectedTime: new Date(expectedTime).toISOString(),
                savedTime: new Date(savedTime).toISOString(),
                timeDifference: `${timeDiff}ms`,
                validated: true
            });
            
        } catch (error) {
            logError(error, 'saveTokenToDB', { 
                empresa_id,
                expiresAt: expires_at?.toISOString?.() || expires_at
            });
            throw error;
        }
    }

    /**
     * ✅ FUNÇÃO MELHORADA: Busca token com normalização automática de data
     */
    async _getTokenFromDB(empresa_id) {
        const logger = createTokenContext(empresa_id);
        
        try {
            const { data, error } = await supabase
                .from("bling_tokens")
                .select("access_token, refresh_token, expires_at")
                .eq("empresa_id", empresa_id)
                .maybeSingle();

            if (error) throw error;
            
            // ✅ NORMALIZAÇÃO AUTOMÁTICA: Garante formato ISO consistente
            if (data && data.expires_at) {
                try {
                    // Converte qualquer formato de data para ISO string padrão
                    const normalizedDate = new Date(data.expires_at).toISOString();
                    data.expires_at = normalizedDate;
                } catch (dateError) {
                    logger.warn('Erro ao normalizar data do token', {
                        operation: 'getTokenFromDB',
                        originalDate: data.expires_at,
                        error: dateError.message
                    });
                    // Se não conseguir normalizar, mantém o original
                }
            }
            
            logger.debug('Token recuperado e normalizado', {
                operation: 'getTokenFromDB',
                hasToken: !!data,
                expiresAt: data?.expires_at
            });
            
            return data;
        } catch (error) {
            logError(error, 'getTokenFromDB', { empresa_id });
            throw error;
        }
    }

    /**
     * Limpa agendamento específico
     */
    clearRenewal(empresa_id) {
        const intervalId = this.renewalIntervals.get(empresa_id);
        if (intervalId) {
            clearTimeout(intervalId);
            this.renewalIntervals.delete(empresa_id);
            
            const logger = createTokenContext(empresa_id);
            logger.debug('Agendamento de renovação removido', {
                operation: 'clearRenewal'
            });
        }
    }

    /**
     * ✅ FUNÇÃO MELHORADA: Limpa todos os recursos
     */
    clearAllRenewals() {
        const totalIntervals = this.renewalIntervals.size;
        const totalMutex = this.renewalMutex.size;
        const totalTimers = this.mutexTimers.size;
        
        this.logger.info('Limpando todos os agendamentos de renovação', {
            operation: 'clearAllRenewals',
            totalIntervals,
            totalMutex,
            totalTimers
        });
        
        // Limpa intervalos de renovação
        for (const [empresa_id, intervalId] of this.renewalIntervals) {
            clearTimeout(intervalId);
        }
        this.renewalIntervals.clear();
        
        // Limpa mutex de renovação
        this.renewalMutex.clear();
        
        // Limpa timers de mutex
        for (const timer of this.mutexTimers.values()) {
            clearTimeout(timer);
        }
        this.mutexTimers.clear();
        
        this.logger.info('Todos os agendamentos removidos', {
            operation: 'clearAllRenewals',
            clearedIntervals: totalIntervals,
            clearedMutex: totalMutex,
            clearedTimers: totalTimers
        });
    }

    /**
     * ✅ FUNÇÃO ATUALIZADA: Atualiza estatísticas do token manager
     */
    _updateStats(success, renewalTime) {
        this.stats.totalRenewals++;
        this.stats.lastRenewalTime = new Date().toISOString();
        
        if (success) {
            this.stats.successfulRenewals++;
        } else {
            this.stats.failedRenewals++;
        }
        
        // Calcula tempo médio de renovação
        this.stats.averageRenewalTime = (
            (this.stats.averageRenewalTime * (this.stats.totalRenewals - 1) + renewalTime) / 
            this.stats.totalRenewals
        );
    }

    /**
     * ✅ FUNÇÃO ATUALIZADA: Obtém estatísticas completas
     */
    getStats() {
        return {
            ...this.stats,
            activeRenewals: this.renewalIntervals.size,
            pendingRenewals: this.renewalMutex.size,
            activeMutexTimers: this.mutexTimers.size,
            successRate: this.stats.totalRenewals > 0 
                ? (this.stats.successfulRenewals / this.stats.totalRenewals * 100).toFixed(2) + '%'
                : '0%',
            averageRenewalTime: Math.round(this.stats.averageRenewalTime) + 'ms'
        };
    }

    /**
     * ✅ FUNÇÃO MELHORADA: Health check detalhado
     */
    getHealthStatus() {
        const stats = this.getStats();
        const recentFailures = this.stats.failedRenewals > this.stats.successfulRenewals * 0.1;
        const hasTimeouts = this.stats.mutexTimeouts > 0;
        const hasPendingMutex = this.renewalMutex.size > 0;
        const hasStuckMutex = this.mutexTimers.size > this.renewalMutex.size;
        
        let status = 'healthy';
        if (recentFailures || hasTimeouts || hasStuckMutex) {
            status = 'warning';
        }
        if (hasPendingMutex && this.stats.mutexTimeouts > 3) {
            status = 'unhealthy';
        }
        
        return {
            status,
            stats,
            issues: {
                recentFailures,
                hasTimeouts,
                hasPendingMutex,
                hasStuckMutex,
                timeoutCount: this.stats.mutexTimeouts,
                autoCleanupCount: this.stats.autoCleanups
            },
            recommendations: this._getHealthRecommendations(status, {
                recentFailures,
                hasTimeouts,
                hasPendingMutex,
                hasStuckMutex
            }),
            timestamp: new Date().toISOString()
        };
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Gera recomendações de saúde
     */
    _getHealthRecommendations(status, issues) {
        const recommendations = [];
        
        if (issues.recentFailures) {
            recommendations.push('Alta taxa de falhas - verificar conectividade com Bling API');
        }
        
        if (issues.hasTimeouts) {
            recommendations.push('Timeouts de mutex detectados - pode indicar deadlocks');
        }
        
        if (issues.hasPendingMutex) {
            recommendations.push('Renovações pendentes - monitorar por travamentos');
        }
        
        if (issues.hasStuckMutex) {
            recommendations.push('Mutex órfãos detectados - limpeza automática ativa');
        }
        
        if (status === 'healthy' && recommendations.length === 0) {
            recommendations.push('Sistema funcionando normalmente');
        }
        
        return recommendations;
    }
}

// Instância singleton
const tokenManager = new TokenManager();

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
    // Funções principais (compatibilidade mantida)
    getValidBlingToken: (empresa_id, accessToken, refresh_token) => 
        tokenManager.getValidToken(empresa_id, accessToken, refresh_token),
    clearAllRenewalIntervals: () => tokenManager.clearAllRenewals(),
    clearRenewalInterval: (empresa_id) => tokenManager.clearRenewal(empresa_id),
    
    // Novas funcionalidades de monitoramento
    getTokenManagerStats: () => tokenManager.getStats(),
    getTokenManagerHealth: () => tokenManager.getHealthStatus(),
    
    // Acesso à instância (para casos avançados)
    tokenManager,
    
    // ✅ FUNÇÕES UTILITÁRIAS CORRIGIDAS
    
    /**
     * Verifica se um token específico é válido sem renovar
     */
    isTokenValid: async (empresa_id) => {
        try {
            const token = await tokenManager._getTokenFromDB(empresa_id);
            return token ? tokenManager._isTokenValid(token) : false;
        } catch (error) {
            return false;
        }
    },
    
    /**
     * Força renovação de token específico
     */
    forceTokenRenewal: async (empresa_id, refresh_token) => {
        try {
            const result = await tokenManager._renewToken(empresa_id, refresh_token);
            return { success: true, access_token: result.access_token };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },
    
    /**
     * Obtém informações detalhadas de um token sem renová-lo
     */
    getTokenInfo: async (empresa_id) => {
        try {
            const tokenData = await tokenManager._getTokenFromDB(empresa_id);
            if (!tokenData) {
                return { exists: false };
            }
            
            const timeUntilExpiry = tokenManager._getTimeUntilExpiry(tokenData.expires_at);
            const isValid = tokenManager._isTokenValid(tokenData);
            
            return {
                exists: true,
                isValid,
                expiresAt: tokenData.expires_at,
                timeUntilExpiry,
                minutesUntilExpiry: Math.round(timeUntilExpiry / 1000 / 60),
                hasRefreshToken: !!tokenData.refresh_token,
                tokenPreview: tokenData.access_token ? 
                    `${tokenData.access_token.substring(0, 8)}***` : null
            };
        } catch (error) {
            return { exists: false, error: error.message };
        }
    },
    
    /**
     * Limpa mutex travado de empresa específica
     */
    clearStuckMutex: (empresa_id) => {
        const key = `empresa_${empresa_id}`;
        if (tokenManager.renewalMutex.has(key)) {
            tokenManager._clearMutex(key);
            tokenManager.stats.mutexTimeouts++;
            return { cleared: true, key };
        }
        return { cleared: false, key };
    },
    
    /**
     * Obtém lista de empresas com renovações ativas
     */
    getActiveRenewals: () => {
        const renewals = [];
        
        for (const [empresa_id, intervalId] of tokenManager.renewalIntervals) {
            renewals.push({
                empresa_id: Number(empresa_id),
                intervalId: intervalId.toString().substring(0, 10) + '...',
                type: 'scheduled'
            });
        }
        
        for (const [key] of tokenManager.renewalMutex) {
            const empresa_id = key.replace('empresa_', '');
            renewals.push({
                empresa_id: Number(empresa_id),
                type: 'active_renewal'
            });
        }
        
        return {
            count: renewals.length,
            renewals,
            scheduledCount: tokenManager.renewalIntervals.size,
            activeCount: tokenManager.renewalMutex.size,
            timestamp: new Date().toISOString()
        };
    },
    
    /**
     * Executa diagnóstico completo do sistema de tokens
     */
    runDiagnostics: async () => {
        const diagnostics = {
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            system: {
                nodeVersion: process.version,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage()
            },
            tokenManager: {
                stats: tokenManager.getStats(),
                health: tokenManager.getHealthStatus(),
                activeRenewals: tokenManager.renewalIntervals.size,
                pendingMutex: tokenManager.renewalMutex.size,
                mutexTimers: tokenManager.mutexTimers.size
            },
            rateLimiter: {
                stats: rateLimiterManager.getAllStats()
            },
            recommendations: []
        };
        
        // Análise e recomendações
        const health = diagnostics.tokenManager.health;
        
        if (health.status !== 'healthy') {
            diagnostics.recommendations.push(
                'Sistema de tokens com problemas - verificar logs e métricas'
            );
        }
        
        if (diagnostics.tokenManager.pendingMutex > 0) {
            diagnostics.recommendations.push(
                `${diagnostics.tokenManager.pendingMutex} renovações pendentes - monitorar por travamentos`
            );
        }
        
        if (diagnostics.tokenManager.mutexTimers > diagnostics.tokenManager.pendingMutex) {
            diagnostics.recommendations.push(
                'Timers de mutex órfãos detectados - limpeza automática ativa'
            );
        }
        
        const memUsageMB = Math.round(diagnostics.system.memoryUsage.heapUsed / 1024 / 1024);
        if (memUsageMB > 500) {
            diagnostics.recommendations.push(
                `Alto uso de memória: ${memUsageMB}MB - considerar restart`
            );
        }
        
        if (diagnostics.recommendations.length === 0) {
            diagnostics.recommendations.push('Sistema funcionando normalmente');
        }
        
        return diagnostics;
    },
    
    /**
     * Realiza manutenção preventiva do sistema de tokens
     */
    performMaintenance: () => {
        const before = {
            intervals: tokenManager.renewalIntervals.size,
            mutex: tokenManager.renewalMutex.size,
            timers: tokenManager.mutexTimers.size
        };
        
        // Força limpeza de recursos órfãos
        let cleaned = 0;
        
        // Limpa mutex órfãos (que não têm renovação correspondente)
        for (const [key] of tokenManager.mutexTimers.entries()) {
            const empresa_key = key;
            if (!tokenManager.renewalMutex.has(empresa_key)) {
                tokenManager._clearMutex(key);
                cleaned++;
            }
        }
        
        const after = {
            intervals: tokenManager.renewalIntervals.size,
            mutex: tokenManager.renewalMutex.size,
            timers: tokenManager.mutexTimers.size
        };
        
        tokenManager.logger.info('Manutenção preventiva concluída', {
            operation: 'performMaintenance',
            before,
            after,
            cleaned,
            timestamp: new Date().toISOString()
        });
        
        return {
            success: true,
            before,
            after,
            cleaned,
            message: `Manutenção concluída: ${cleaned} recursos órfãos removidos`,
            timestamp: new Date().toISOString()
        };
    }
};