// src/services/supabaseService.js - VERSÃO CORRIGIDA
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY } = require("../config");
const { logger } = require("../utils/logger");

class SupabaseManager {
  constructor() {
    this.client = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.init();
  }

  init() {
    try {
      this.client = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 10 } }
      });
      
      logger.info('✅ Supabase cliente inicializado', {
        service: 'flowb2b-api'
      });
      this.reconnectAttempts = 0;
    } catch (error) {
      logger.error('❌ Erro ao inicializar Supabase', { 
        service: 'flowb2b-api',
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * ✅ CORREÇÃO CRÍTICA: Retorna diretamente o QueryBuilder do Supabase
   * Isso permite o encadeamento correto de métodos como .eq(), .select(), etc.
   */
  from(table) {
    if (!this.client) {
      throw new Error('Cliente Supabase não disponível');
    }

    try {
      // ✅ CORREÇÃO: Retorna diretamente o QueryBuilder
      return this.client.from(table);
    } catch (error) {
      logger.warn('Erro ao acessar tabela Supabase, tentando reconectar', {
        service: 'flowb2b-api',
        table,
        error: error.message,
        reconnectAttempts: this.reconnectAttempts
      });

      // Tenta reconectar se ainda não excedeu o limite
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.init();
        
        // Tenta novamente após reconectar
        return this.client.from(table);
      }
      
      throw error;
    }
  }

  /**
   * ✅ NOVA FUNÇÃO: Para queries mais complexas que precisam de tratamento de erro
   */
  async executeQuery(queryFn) {
    try {
      if (!this.client) {
        throw new Error('Cliente Supabase não disponível');
      }

      const result = await queryFn(this.client);
      
      // Reset contador de reconexão em caso de sucesso
      this.reconnectAttempts = 0;
      
      return result;
    } catch (error) {
      logger.warn('Erro na query Supabase, tentando reconectar', {
        service: 'flowb2b-api',
        error: error.message,
        reconnectAttempts: this.reconnectAttempts
      });

      // Tenta reconectar se ainda não excedeu o limite
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.init();
        
        // Tenta novamente após reconectar
        return await queryFn(this.client);
      }
      
      throw error;
    }
  }

  /**
   * ✅ NOVA FUNÇÃO: Health check do Supabase
   */
  async healthCheck() {
    try {
      if (!this.client) {
        return { healthy: false, error: 'Cliente não inicializado' };
      }

      // Testa conexão básica
      const { error } = await this.client
        .from('bling_tokens')
        .select('count', { count: 'exact', head: true });
      
      if (error) {
        return { 
          healthy: false, 
          error: error.message,
          details: error.details,
          hint: error.hint 
        };
      }
      
      return { 
        healthy: true, 
        timestamp: new Date().toISOString(),
        reconnectAttempts: this.reconnectAttempts 
      };
    } catch (error) {
      return { 
        healthy: false, 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * ✅ NOVA FUNÇÃO: Força reconexão
   */
  forceReconnect() {
    logger.info('🔄 Forçando reconexão do Supabase', {
      service: 'flowb2b-api'
    });
    
    this.reconnectAttempts = 0;
    this.init();
  }

  /**
   * ✅ NOVA FUNÇÃO: Obtém estatísticas da conexão
   */
  getConnectionStats() {
    return {
      isConnected: !!this.client,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      timestamp: new Date().toISOString()
    };
  }
}

// ✅ CORREÇÃO: Instância singleton
const supabaseManager = new SupabaseManager();

// ✅ CORREÇÃO CRÍTICA: Exporta o manager, não métodos wrapper
// Isso permite que o código existente funcione sem mudanças
module.exports = supabaseManager;