import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { I18nService, LANGUAGES, Language } from './i18n.service';
import { TranslatePipe } from './t.pipe';

@Component({
  selector: 'app-language-picker',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <label class="flex items-center gap-2 text-xs" [class.text-gray-400]="dark" [class.text-gray-600]="!dark">
      <span>{{ 'Language' | t }}</span>
      <select class="select select-bordered select-xs" [class.bg-gray-700]="dark" [class.text-white]="dark"
              aria-label="Language" data-testid="language-picker"
              [value]="i18n.language()" (change)="choose($any($event.target).value)">
        <option *ngFor="let l of languages" [value]="l.code">{{ l.native }}</option>
      </select>
    </label>
  `,
  inputs: ['dark']
})
export class LanguagePickerComponent {
  dark = false;
  readonly languages = LANGUAGES;
  constructor(public i18n: I18nService) { }
  choose(code: string): void {
    if (code === 'en' || code === 'ta' || code === 'hi') this.i18n.setLanguage(code as Language);
  }
}
