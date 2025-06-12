// src/services/supabaseService.js
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
      
      logger.info('✅ Supabase cliente inicializado');
      this.reconnectAttempts = 0;
    } catch (error) {
      logger.error('❌ Erro ao inicializar Supabase', { error: error.message });
      throw error;
    }
  }

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

  from(table) {
    return {
      select: (...args) => this.executeQuery(client => client.from(table).select(...args)),
      insert: (...args) => this.executeQuery(client => client.from(table).insert(...args)),
      update: (...args) => this.executeQuery(client => client.from(table).update(...args)),
      upsert: (...args) => this.executeQuery(client => client.from(table).upsert(...args)),
      delete: (...args) => this.executeQuery(client => client.from(table).delete(...args))
    };
  }
}

const supabaseManager = new SupabaseManager();
module.exports = supabaseManager;