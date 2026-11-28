import { Pipe, PipeTransform } from '@angular/core';
import { I18nService } from './i18n.service';

/** `{{ 'Patient Queue' | t }}` or `{{ 'Good Morning, {name}' | t:{ name: user } }}`. */
@Pipe({ name: 't', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  constructor(private i18n: I18nService) { }
  transform(text: string, params?: Record<string, unknown>): string {
    return this.i18n.t(text, params);
  }
}
