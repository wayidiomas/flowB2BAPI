// src/services/metricsService.js
const { logPerformanceMetrics, logger } = require('../utils/logger');
const { MONITORING } = require('../config/SyncConfig');

/**
 * Sistema de métricas para monitoramento de performance da sincronização
 * Coleta, processa e reporta métricas em tempo real
 */

// ===========================
// CLASSES DE MÉTRICAS
// ===========================

/**
 * Métrica individual para rastrear operações
 */
class Metric {
  constructor(name, type = 'counter') {
    this.name = name;
    this.type = type; // counter, timer, gauge, histogram
    this.value = type === 'counter' ? 0 : null;
    this.samples = []; // Para histogramas e timers
    this.startTime = null;
    this.metadata = {};
  }

  /**
   * Incrementa contador
   */
  increment(value = 1) {
    if (this.type !== 'counter') throw new Error('Cannot increment non-counter metric');
    this.value += value;
    this.updateTimestamp();
    return this;
  }

  /**
   * Define valor direto (para gauges)
   */
  setValue(value) {
    if (this.type !== 'gauge') throw new Error('setValue only available for gauge metrics');
    this.value = value;
    this.updateTimestamp();
    return this;
  }

  /**
   * Inicia timer
   */
  startTimer() {
    if (this.type !== 'timer') throw new Error('startTimer only available for timer metrics');
    this.startTime = Date.now();
    return this;
  }

  /**
   * Para timer e registra duração
   */
  stopTimer() {
    if (this.type !== 'timer') throw new Error('stopTimer only available for timer metrics');
    if (!this.startTime) throw new Error('Timer not started');
    
    const duration = Date.now() - this.startTime;
    this.samples.push({
      value: duration,
      timestamp: new Date().toISOString()
    });
    
    this.startTime = null;
    this.updateTimestamp();
    return duration;
  }

  /**
   * Adiciona amostra para histograma
   */
  observe(value) {
    if (this.type !== 'histogram') throw new Error('observe only available for histogram metrics');
    this.samples.push({
      value,
      timestamp: new Date().toISOString()
    });
    this.updateTimestamp();
    return this;
  }

  /**
   * Adiciona metadados
   */
  addMetadata(key, value) {
    this.metadata[key] = value;
    return this;
  }

  /**
   * Atualiza timestamp da última modificação
   */
  updateTimestamp() {
    this.lastUpdated = new Date().toISOString();
  }

  /**
   * Retorna estatísticas da métrica
   */
  getStats() {
    const stats = {
      name: this.name,
      type: this.type,
      lastUpdated: this.lastUpdated,
      metadata: this.metadata
    };

    switch (this.type) {
      case 'counter':
      case 'gauge':
        stats.value = this.value;
        break;
      
      case 'timer':
      case 'histogram':
        if (this.samples.length > 0) {
          const values = this.samples.map(s => s.value);
          stats.count = values.length;
          stats.min = Math.min(...values);
          stats.max = Math.max(...values);
          stats.avg = values.reduce((a, b) => a + b, 0) / values.length;
          stats.sum = values.reduce((a, b) => a + b, 0);
          
          // Percentis
          const sorted = values.sort((a, b) => a - b);
          stats.p50 = this.percentile(sorted, 50);
          stats.p90 = this.percentile(sorted, 90);
          stats.p95 = this.percentile(sorted, 95);
          stats.p99 = this.percentile(sorted, 99);
          
          stats.samples = this.samples.slice(-10); // Últimas 10 amostras
        } else {
          stats.count = 0;
        }
        break;
    }

    return stats;
  }

  /**
   * Calcula percentil
   */
  percentile(sorted, p) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }

  /**
   * Reset da métrica
   */
  reset() {
    switch (this.type) {
      case 'counter':
        this.value = 0;
        break;
      case 'gauge':
        this.value = null;
        break;
      case 'timer':
      case 'histogram':
        this.samples = [];
        this.startTime = null;
        break;
    }
    this.updateTimestamp();
    return this;
  }
}

/**
 * Contexto de sincronização para agrupar métricas relacionadas
 */
class SyncMetrics {
  constructor(empresa_id, syncType, operation = null) {
    this.empresa_id = Number(empresa_id);
    this.syncType = syncType; // 'first-time', 'daily', 'inventory'
    this.operation = operation;
    this.startTime = Date.now();
    this.endTime = null;
    this.currentStep = null;
    this.status = 'running';
    
    // Métricas gerais
    this.metrics = {
      // Contadores
      recordsProcessed: new Metric('records_processed', 'counter'),
      errorsCount: new Metric('errors_count', 'counter'),
      retriesCount: new Metric('retries_count', 'counter'),
      pagesProcessed: new Metric('pages_processed', 'counter'),
      
      // Timers
      totalDuration: new Metric('total_duration', 'timer'),
      stepDuration: new Metric('step_duration', 'timer'),
      requestDuration: new Metric('request_duration', 'timer'),
      
      // Gauges
      currentPage: new Metric('current_page', 'gauge'),
      memoryUsage: new Metric('memory_usage', 'gauge'),
      
      // Histogramas
      responseTime: new Metric('response_time', 'histogram'),
      retryDelay: new Metric('retry_delay', 'histogram'),
    };
    
    // Métricas por step
    this.stepMetrics = new Map();
    
    // Histórico de erros
    this.errors = [];
    
    // Inicia timer total
    this.metrics.totalDuration.startTimer();
    
    // Adiciona metadados
    Object.values(this.metrics).forEach(metric => {
      metric.addMetadata('empresa_id', this.empresa_id)
            .addMetadata('syncType', this.syncType)
            .addMetadata('operation', this.operation);
    });
  }

  /**
   * Inicia um novo step
   */
  startStep(stepName) {
    // Para step anterior se existir
    if (this.currentStep) {
      this.endStep();
    }
    
    this.currentStep = stepName;
    
    // Cria métricas específicas do step se não existir
    if (!this.stepMetrics.has(stepName)) {
      this.stepMetrics.set(stepName, {
        name: stepName,
        startTime: Date.now(),
        endTime: null,
        recordsProcessed: 0,
        pagesProcessed: 0,
        errorsCount: 0,
        retriesCount: 0,
        status: 'running'
      });
    }
    
    // Inicia timer do step
    this.metrics.stepDuration.startTimer();
    
    logger.debug(`📊 Step iniciado: ${stepName}`, {
      service: 'metrics',
      empresa_id: this.empresa_id,
      syncType: this.syncType,
      step: stepName
    });

    return this;
  }

  /**
   * Finaliza step atual
   */
  endStep(status = 'completed') {
    if (!this.currentStep) return this;
    
    const stepData = this.stepMetrics.get(this.currentStep);
    if (stepData) {
      stepData.endTime = Date.now();
      stepData.duration = stepData.endTime - stepData.startTime;
      stepData.status = status;
    }
    
    // Para timer do step
    const stepDuration = this.metrics.stepDuration.stopTimer();
    
    logger.debug(`📊 Step finalizado: ${this.currentStep}`, {
      service: 'metrics',
      empresa_id: this.empresa_id,
      syncType: this.syncType,
      step: this.currentStep,
      duration: `${stepDuration}ms`,
      status
    });

    this.currentStep = null;
    return this;
  }

  /**
   * Registra processamento de registros
   */
  recordsProcessed(count) {
    this.metrics.recordsProcessed.increment(count);
    
    if (this.currentStep) {
      const stepData = this.stepMetrics.get(this.currentStep);
      if (stepData) stepData.recordsProcessed += count;
    }
    
    return this;
  }

  /**
   * Registra processamento de página
   */
  pageProcessed(pageNumber, recordCount = 0) {
    this.metrics.pagesProcessed.increment(1);
    this.metrics.currentPage.setValue(pageNumber);
    
    if (recordCount > 0) {
      this.recordsProcessed(recordCount);
    }
    
    if (this.currentStep) {
      const stepData = this.stepMetrics.get(this.currentStep);
      if (stepData) stepData.pagesProcessed += 1;
    }
    
    return this;
  }

  /**
   * Registra erro
   */
  recordError(error, context = {}) {
    this.metrics.errorsCount.increment(1);
    
    const errorInfo = {
      timestamp: new Date().toISOString(),
      message: error.message,
      name: error.name,
      stack: error.stack,
      ...(error.status && { status: error.status }),
      ...(error.code && { code: error.code }),
      step: this.currentStep,
      ...context
    };
    
    this.errors.push(errorInfo);
    
    if (this.currentStep) {
      const stepData = this.stepMetrics.get(this.currentStep);
      if (stepData) stepData.errorsCount += 1;
    }
    
    // Mantém apenas os últimos 50 erros
    if (this.errors.length > 50) {
      this.errors = this.errors.slice(-50);
    }
    
    return this;
  }

  /**
   * Registra retry
   */
  recordRetry(delay = 0) {
    this.metrics.retriesCount.increment(1);
    
    if (delay > 0) {
      this.metrics.retryDelay.observe(delay);
    }
    
    if (this.currentStep) {
      const stepData = this.stepMetrics.get(this.currentStep);
      if (stepData) stepData.retriesCount += 1;
    }
    
    return this;
  }

  /**
   * Registra tempo de resposta de request
   */
  recordRequestTime(duration) {
    this.metrics.responseTime.observe(duration);
    return this;
  }

  /**
   * Atualiza uso de memória
   */
  updateMemoryUsage() {
    const memUsage = process.memoryUsage();
    const memInMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    this.metrics.memoryUsage.setValue(memInMB);
    return this;
  }

  /**
   * Finaliza sincronização
   */
  finish(status = 'completed') {
    this.endStep(); // Finaliza step atual se existir
    
    this.endTime = Date.now();
    this.status = status;
    
    // Para timer total
    const totalDuration = this.metrics.totalDuration.stopTimer();
    
    // Atualiza memória final
    this.updateMemoryUsage();
    
    // Log de métricas finais
    this.logFinalMetrics();
    
    logger.info(`📊 Sincronização finalizada: ${this.syncType}`, {
      service: 'metrics',
      empresa_id: this.empresa_id,
      syncType: this.syncType,
      status,
      duration: `${totalDuration}ms`,
      recordsProcessed: this.metrics.recordsProcessed.value,
      errorsCount: this.metrics.errorsCount.value
    });

    return this;
  }

  /**
   * Gera relatório completo de métricas
   */
  getReport() {
    const report = {
      // Informações gerais
      empresa_id: this.empresa_id,
      syncType: this.syncType,
      operation: this.operation,
      status: this.status,
      startTime: new Date(this.startTime).toISOString(),
      endTime: this.endTime ? new Date(this.endTime).toISOString() : null,
      duration: this.endTime ? this.endTime - this.startTime : Date.now() - this.startTime,
      
      // Métricas principais
      summary: {
        recordsProcessed: this.metrics.recordsProcessed.value,
        pagesProcessed: this.metrics.pagesProcessed.value,
        errorsCount: this.metrics.errorsCount.value,
        retriesCount: this.metrics.retriesCount.value,
        memoryUsageMB: this.metrics.memoryUsage.value
      },
      
      // Estatísticas detalhadas
      performance: {
        responseTime: this.metrics.responseTime.getStats(),
        retryDelay: this.metrics.retryDelay.getStats()
      },
      
      // Métricas por step
      steps: Array.from(this.stepMetrics.entries()).map(([name, data]) => ({
        name,
        ...data,
        duration: data.endTime ? data.endTime - data.startTime : null
      })),
      
      // Últimos erros
      recentErrors: this.errors.slice(-10),
      
      // Timestamp do relatório
      reportGenerated: new Date().toISOString()
    };
    
    return report;
  }

  /**
   * Loga métricas finais
   */
  logFinalMetrics() {
    const report = this.getReport();
    
    logPerformanceMetrics(`${this.syncType}_sync`, {
      empresa_id: this.empresa_id,
      duration: `${report.duration}ms`,
      recordsProcessed: report.summary.recordsProcessed,
      pagesProcessed: report.summary.pagesProcessed,
      errorsCount: report.summary.errorsCount,
      retriesCount: report.summary.retriesCount,
      stepsCompleted: report.steps.filter(s => s.status === 'completed').length,
      memoryUsageMB: report.summary.memoryUsageMB,
      avgResponseTime: report.performance.responseTime.avg || 0
    });
  }
}

// ===========================
// GERENCIADOR DE MÉTRICAS GLOBAL
// ===========================

class MetricsManager {
  constructor() {
    this.activeSyncs = new Map(); // syncKey -> SyncMetrics
    this.globalMetrics = {
      totalSyncs: new Metric('total_syncs', 'counter'),
      activeSyncs: new Metric('active_syncs', 'gauge'),
      systemMemory: new Metric('system_memory', 'gauge'),
      uptime: new Metric('uptime', 'gauge')
    };
    
    // Histórico de sincronizações por empresa (últimas 10)
    this.syncHistory = new Map(); // empresa_id -> Array<SyncReport>
    
    // Inicia coleta de métricas do sistema
    if (MONITORING.COLLECT_METRICS) {
      this.startSystemMetricsCollection();
    }
  }

  /**
   * Gera chave única para sincronização
   */
  _generateSyncKey(empresa_id, syncType) {
    return `empresa_${empresa_id}_${syncType}`;
  }

  /**
   * Inicia nova sincronização
   */
  startSync(empresa_id, syncType, operation = null) {
    const syncKey = this._generateSyncKey(empresa_id, syncType);
    const syncMetrics = new SyncMetrics(empresa_id, syncType, operation);
    
    // Verifica se já existe sincronização do mesmo tipo
    if (this.activeSyncs.has(syncKey)) {
      const existingSync = this.activeSyncs.get(syncKey);
      logger.warn(`⚠️ Substituindo sincronização ativa existente`, {
        service: 'metrics',
        empresa_id,
        syncType,
        existingOperation: existingSync.operation,
        newOperation: operation
      });
      
      // Finaliza a anterior como 'replaced'
      existingSync.finish('replaced');
    }
    
    this.activeSyncs.set(syncKey, syncMetrics);
    this.globalMetrics.totalSyncs.increment(1);
    this.globalMetrics.activeSyncs.setValue(this.activeSyncs.size);
    
    logger.info(`📊 Métricas iniciadas para sincronização`, {
      service: 'metrics',
      empresa_id,
      syncType,
      operation,
      syncKey
    });

    return syncMetrics;
  }

  /**
   * Finaliza sincronização
   */
  finishSync(empresa_id, syncType, status = 'completed') {
    const syncKey = this._generateSyncKey(empresa_id, syncType);
    const syncMetrics = this.activeSyncs.get(syncKey);
    
    if (syncMetrics) {
      syncMetrics.finish(status);
      this.activeSyncs.delete(syncKey);
      this.globalMetrics.activeSyncs.setValue(this.activeSyncs.size);
      
      // Adiciona ao histórico
      this._addToHistory(empresa_id, syncMetrics.getReport());
    }
    
    return syncMetrics;
  }

  /**
   * Obtém métricas de sincronização ativa específica
   */
  getSyncMetrics(empresa_id, syncType) {
    const syncKey = this._generateSyncKey(empresa_id, syncType);
    return this.activeSyncs.get(syncKey);
  }

  /**
   * Obtém todas as métricas de sincronizações ativas de uma empresa
   */
  getCompanySyncMetrics(empresa_id) {
    const companySyncs = [];
    
    for (const [syncKey, syncMetrics] of this.activeSyncs.entries()) {
      if (syncMetrics.empresa_id === Number(empresa_id)) {
        companySyncs.push({
          syncType: syncMetrics.syncType,
          operation: syncMetrics.operation,
          metrics: syncMetrics,
          syncKey
        });
      }
    }
    
    return companySyncs;
  }

  /**
   * Adiciona sincronização ao histórico
   */
  _addToHistory(empresa_id, report) {
    if (!this.syncHistory.has(empresa_id)) {
      this.syncHistory.set(empresa_id, []);
    }
    
    const history = this.syncHistory.get(empresa_id);
    history.push(report);
    
    // Mantém apenas as últimas 10 sincronizações
    if (history.length > 10) {
      this.syncHistory.set(empresa_id, history.slice(-10));
    }
  }

  /**
   * Obtém métricas globais do sistema
   */
  getGlobalMetrics() {
    return {
      metrics: Object.fromEntries(
        Object.entries(this.globalMetrics).map(([key, metric]) => [key, metric.getStats()])
      ),
      activeSyncs: Array.from(this.activeSyncs.entries()).map(([empresa_id, sync]) => ({
        empresa_id,
        syncType: sync.syncType,
        operation: sync.operation,
        status: sync.status,
        currentStep: sync.currentStep,
        startTime: new Date(sync.startTime).toISOString(),
        recordsProcessed: sync.metrics.recordsProcessed.value
      })),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Inicia coleta automática de métricas do sistema
   */
  startSystemMetricsCollection() {
    setInterval(() => {
      // Memória do sistema
      const memUsage = process.memoryUsage();
      const memInMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      this.globalMetrics.systemMemory.setValue(memInMB);
      
      // Uptime
      this.globalMetrics.uptime.setValue(Math.floor(process.uptime()));
      
      // Atualiza memória das sincronizações ativas
      for (const syncMetrics of this.activeSyncs.values()) {
        syncMetrics.updateMemoryUsage();
      }
      
    }, MONITORING.METRICS_INTERVAL);
  }

  /**
   * Gera health check
   */
  getHealthCheck() {
    const memUsage = process.memoryUsage();
    const activeSyncsCount = this.activeSyncs.size;
    
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024), // MB
      },
      activeSyncs: activeSyncsCount,
      totalSyncs: this.globalMetrics.totalSyncs.value
    };
  }
}

// ===========================
// INSTÂNCIA SINGLETON
// ===========================

const metricsManager = new MetricsManager();

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
  // Classes
  Metric,
  SyncMetrics,
  MetricsManager,
  
  // Instância singleton
  metricsManager,
  
  // Funções convenientes
  startSync: (empresa_id, syncType, operation) => metricsManager.startSync(empresa_id, syncType, operation),
  finishSync: (empresa_id, status) => metricsManager.finishSync(empresa_id, status),
  getSyncMetrics: (empresa_id) => metricsManager.getSyncMetrics(empresa_id),
  getGlobalMetrics: () => metricsManager.getGlobalMetrics(),
  getHealthCheck: () => metricsManager.getHealthCheck(),
};