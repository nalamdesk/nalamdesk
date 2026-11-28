import { Injectable, signal } from '@angular/core';
import { TA } from './ta';
import { HI } from './hi';

export type Language = 'en' | 'ta' | 'hi';

export const LANGUAGES: { code: Language; label: string; native: string }[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' }
];

const DICTIONARIES: Record<Exclude<Language, 'en'>, Record<string, string>> = { ta: TA, hi: HI };

/** Fills {name} placeholders from params; unknown placeholders stay as written. */
export function interpolate(text: string, params?: Record<string, unknown>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key) => (params[key] == null ? whole : String(params[key])));
}

/**
 * Interface language, chosen per computer (or browser) and kept in this
 * client's local storage, never on the server: the front desk can work in
 * Tamil while the doctor's room stays in English. English is the default
 * and the key of every translation, so an untranslated string shows in
 * English rather than as a key.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  static readonly STORAGE_KEY = 'nd.language';
  readonly language = signal<Language>('en');

  constructor() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(I18nService.STORAGE_KEY); } catch { /* private mode */ }
    this.apply(saved === 'ta' || saved === 'hi' ? saved : 'en');
  }

  setLanguage(lang: Language): void {
    this.apply(lang);
    try { localStorage.setItem(I18nService.STORAGE_KEY, lang); } catch { /* ignore */ }
  }

  t(text: string, params?: Record<string, unknown>): string {
    const lang = this.language();
    const translated = lang === 'en' ? text : (DICTIONARIES[lang][text] ?? text);
    return interpolate(translated, params);
  }

  private apply(lang: Language): void {
    this.language.set(lang);
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }
}
