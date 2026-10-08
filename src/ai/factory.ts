import { AIProvider } from './types';
import { GeminiProvider } from './gemini';

/**
 * AI Provider factory - selects provider based on user configuration
 * 
 * Priority order:
 * 1. Chrome built-in AI (opt-out) - if available
 * 2. Gemini API (BYO key)
 * 3. Ollama/local server
 * 4. Disabled
 */
export class AIProviderFactory {
  private static instance: AIProviderFactory;
  private provider: AIProvider | null = null;
  private currentProviderName: string | null = null;

  private constructor() {}

  static getInstance(): AIProviderFactory {
    if (!AIProviderFactory.instance) {
      AIProviderFactory.instance = new AIProviderFactory();
    }
    return AIProviderFactory.instance;
  }

  /**
   * Initialize provider based on configuration
   */
  async initialize(config: {
    preferredProvider?: 'gemini' | 'ollama' | 'chrome';
    geminiApiKey?: string;
    ollamaUrl?: string;
    useChromeAI?: boolean;
  }): Promise<AIProvider> {
    // Don't recreate if same provider already active
    if (this.provider && this.currentProviderName === config.preferredProvider) {
      return this.provider;
    }

    // Close existing provider if any
    if (this.provider?.close) {
      this.provider.close();
    }

    let newProvider: AIProvider | null = null;

    // Try Chrome built-in AI first if enabled
    if (config.useChromeAI !== false && typeof (globalThis as unknown as { chrome?: unknown }).chrome !== 'undefined') {
      // Chrome AI would go here (optional feature)
      console.log('[nobait] Chrome AI not yet implemented, falling back to Gemini');
    }

    // Default to Gemini
    if (config.preferredProvider === 'gemini' || !config.preferredProvider) {
      const gemini = new GeminiProvider(config.geminiApiKey);
      if (!config.geminiApiKey) {
        await gemini.loadApiKey();
      }
      newProvider = gemini;
      this.currentProviderName = 'gemini';
    }

    if (!newProvider) {
      throw new Error('[nobait] No available AI provider configured');
    }

    this.provider = newProvider;
    console.log(`[nobait] Initialized AI provider: ${this.currentProviderName}`);
    return newProvider;
  }

  /**
   * Get current provider
   */
  getProvider(): AIProvider | null {
    return this.provider;
  }

  /**
   * Get current provider name
   */
  getCurrentProviderName(): string | null {
    return this.currentProviderName;
  }

  /**
   * Reset provider (will re-initialize on next call)
   */
  reset(): void {
    if (this.provider?.close) {
      this.provider.close();
    }
    this.provider = null;
    this.currentProviderName = null;
  }
}

// Export singleton
export const aiProviderFactory = AIProviderFactory.getInstance();
