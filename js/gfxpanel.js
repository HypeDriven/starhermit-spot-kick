'use strict';

/*
 * Spot Kick Graphics settings section (inside the Pause/Settings overlay).
 * Builds the controls from the gfx.js model, localizes the panel strings
 * (navigator language; the rest of the game is English), persists through the
 * game's settings store and applies changes live via the renderer.
 */
(function (root, factory) {
  const api = factory(root.SpotKickGfx);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickGfxPanel = api;
})(typeof self !== 'undefined' ? self : this, function (GFX) {

  const EN = {
    graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {t})', renderScale: 'Render scale',
    fromPreset: 'From preset ({t})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postUnavailable: 'Post-processing is unavailable here; the game renders without it.',
    preset: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cat: { shadows: 'Shadows', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
      reflections: 'Reflections', detail: 'Surface detail', crowd: 'Crowd', atmosphere: 'Floodlight atmosphere' },
    tier: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Plain', detailed: 'Detailed', sparse: 'Sparse', full: 'Full' }
  };
  const ext = (base, over) => {
    const o = Object.assign({}, base, over);
    for (const k of ['preset', 'cat', 'tier']) o[k] = Object.assign({}, base[k], over[k] || {});
    return o;
  };
  const ES = ext(EN, {
    graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {t})', renderScale: 'Escala de renderizado',
    fromPreset: 'Según el ajuste ({t})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar cuadros por segundo',
    postUnavailable: 'El posprocesado no está disponible aquí; el juego se dibuja sin él.',
    preset: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cat: { shadows: 'Sombras', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
      reflections: 'Reflejos', detail: 'Detalle de superficies', crowd: 'Público', atmosphere: 'Ambiente de reflectores' },
    tier: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', plain: 'Simple', detailed: 'Detallado', sparse: 'Escaso', full: 'Lleno' }
  });
  const ES_ES = ext(ES, { showFps: 'Mostrar fotogramas por segundo', cat: { atmosphere: 'Ambiente de focos' } });
  const FR = ext(EN, {
    graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {t})', renderScale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({t})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postUnavailable: 'Le post-traitement est indisponible ici ; le jeu s’affiche sans.',
    preset: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    cat: { shadows: 'Ombres', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
      reflections: 'Reflets', detail: 'Détail des surfaces', crowd: 'Public', atmosphere: 'Ambiance des projecteurs' },
    tier: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', plain: 'Simple', detailed: 'Détaillé', sparse: 'Clairsemé', full: 'Complet' }
  });
  const FR_CA = ext(FR, { showFps: 'Afficher le nombre d’images par seconde', cat: { crowd: 'Foule', antialias: 'Lissage des bordures' } });
  const LOCALES = {
    'en-US': EN,
    'en-GB': ext(EN, { cat: { grade: 'Colour grade' } }),
    'es-419': ES,
    'es-ES': ES_ES,
    'fr-FR': FR,
    'fr-CA': FR_CA,
    'de-DE': ext(EN, {
      graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {t})', renderScale: 'Renderskalierung',
      fromPreset: 'Wie Voreinstellung ({t})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
      postUnavailable: 'Nachbearbeitung ist hier nicht verfügbar; das Spiel wird ohne sie dargestellt.',
      preset: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
      cat: { shadows: 'Schatten', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
        reflections: 'Spiegelungen', detail: 'Oberflächendetails', crowd: 'Publikum', atmosphere: 'Flutlicht-Atmosphäre' },
      tier: { off: 'Aus', on: 'Ein', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', plain: 'Einfach', detailed: 'Detailliert', sparse: 'Spärlich', full: 'Voll' }
    }),
    'pt-BR': ext(EN, {
      graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automático (detectado: {t})', renderScale: 'Escala de renderização',
      fromPreset: 'Da predefinição ({t})', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
      postUnavailable: 'O pós-processamento não está disponível aqui; o jogo é exibido sem ele.',
      preset: { low: 'Baixo', balanced: 'Equilibrado', high: 'Alto', ultra: 'Ultra' },
      cat: { shadows: 'Sombras', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
        reflections: 'Reflexos', detail: 'Detalhe das superfícies', crowd: 'Torcida', atmosphere: 'Atmosfera dos refletores' },
      tier: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', plain: 'Simples', detailed: 'Detalhado', sparse: 'Esparsa', full: 'Cheia' }
    }),
    'it-IT': ext(EN, {
      graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {t})', renderScale: 'Scala di rendering',
      fromPreset: 'Dal preset ({t})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
      postUnavailable: 'La post-elaborazione non è disponibile qui; il gioco viene mostrato senza.',
      preset: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
      cat: { shadows: 'Ombre', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
        reflections: 'Riflessi', detail: 'Dettaglio superfici', crowd: 'Pubblico', atmosphere: 'Atmosfera dei riflettori' },
      tier: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', plain: 'Semplice', detailed: 'Dettagliato', sparse: 'Scarso', full: 'Pieno' }
    })
  };
  const FALLBACK = { en: 'en-US', es: 'es-419', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT' };

  function pickLocale(lang) {
    const l = String(lang || 'en-US');
    const exact = Object.keys(LOCALES).find(k => k.toLowerCase() === l.toLowerCase());
    if (exact) return exact;
    const base = l.split('-')[0].toLowerCase();
    if (base === 'es' && /-es$/i.test(l)) return 'es-ES';
    return FALLBACK[base] || 'en-US';
  }

  let S = EN, locale = 'en-US';
  let opts = null;
  const $ = (id) => document.getElementById(id);
  const fmt = (s, t) => s.replace('{t}', t);

  function tierLabel(t) { return S.tier[t] || t; }

  function init(o) {
    opts = o;
    locale = pickLocale(o.lang);
    S = LOCALES[locale];
    const fs = $('gfx-fieldset');
    if (!fs) return;
    fs.setAttribute('lang', locale);
    $('gfx-legend').textContent = S.graphics;
    $('gfx-quality-label').textContent = S.quality;
    $('gfx-scale-label').textContent = S.renderScale;
    $('gfx-adaptive-label').textContent = S.adaptive;
    $('gfx-fps-label').textContent = S.showFps;
    $('gfx-post-note').textContent = S.postUnavailable;
    // one select per category
    const host = $('gfx-categories');
    host.innerHTML = '';
    Object.keys(GFX.CATEGORIES).forEach(cat => {
      const lab = document.createElement('label');
      const span = document.createElement('span');
      span.textContent = S.cat[cat];
      const sel = document.createElement('select');
      sel.id = 'gfx-' + cat;
      sel.dataset.gfxCat = cat;
      lab.append(span, sel);
      host.appendChild(lab);
      sel.addEventListener('change', () => {
        const saved = Object.assign({}, opts.getSaved());
        if (sel.value === 'preset') delete saved[cat]; else saved[cat] = sel.value;
        commit(saved);
      });
    });
    $('opt-quality').addEventListener('change', (e) => {
      commit(GFX.choosePreset(opts.getSaved(), e.target.value)); // clears overrides
    });
    const scale = $('opt-render-scale');
    scale.addEventListener('input', () => {
      $('opt-render-scale-out').value = scale.value + '%';
      commit(Object.assign({}, opts.getSaved(), { render_scale: +scale.value / 100 }));
    });
    $('gfx-adaptive').addEventListener('change', (e) => commit(Object.assign({}, opts.getSaved(), { adaptive: e.target.checked })));
    $('gfx-show-fps').addEventListener('change', (e) => commit(Object.assign({}, opts.getSaved(), { show_fps: e.target.checked })));
    const ov = $('overlay-pause'); // refresh GPU/size summary whenever settings open
    if (ov && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (!ov.classList.contains('hidden')) sync(); }).observe(ov, { attributes: true, attributeFilter: ['class'] });
    }
    sync();
  }

  function commit(saved) {
    opts.save(saved);
    opts.render.setGraphics(saved);
    sync();
    if (opts.onChange) opts.onChange(saved);
    // pixel size settles on the next frame
    requestAnimationFrame(() => requestAnimationFrame(refreshSummary));
  }

  /** Reflect saved + resolved state in every control. */
  function sync() {
    if (!opts || !$('gfx-fieldset')) return;
    const saved = opts.getSaved() || {};
    const info = opts.render.graphicsInfo();
    const r = info.resolved;
    const q = $('opt-quality');
    q.innerHTML = '';
    const add = (sel, v, text) => { const o = document.createElement('option'); o.value = v; o.textContent = text; sel.appendChild(o); };
    add(q, 'auto', fmt(S.auto, S.preset[info.detected]));
    GFX.PRESETS.forEach(p => add(q, p, S.preset[p]));
    q.value = GFX.PRESETS.indexOf(saved.preset) >= 0 ? saved.preset : 'auto';
    Object.keys(GFX.CATEGORIES).forEach(cat => {
      const sel = $('gfx-' + cat);
      sel.innerHTML = '';
      add(sel, 'preset', fmt(S.fromPreset, tierLabel(GFX.presetTier(r.preset, cat))));
      GFX.CATEGORIES[cat].forEach(t => add(sel, t, tierLabel(t)));
      sel.value = GFX.CATEGORIES[cat].indexOf(saved[cat]) >= 0 ? saved[cat] : 'preset';
    });
    const pct = Math.round(r.renderScale * 100);
    $('opt-render-scale').value = pct;
    $('opt-render-scale-out').value = pct + '%';
    $('gfx-adaptive').checked = r.adaptive;
    $('gfx-show-fps').checked = r.showFps;
    document.body.dataset.gfxPreset = r.preset;
    refreshSummary();
  }

  function refreshSummary() {
    if (!opts || !$('gfx-summary')) return;
    const info = opts.render.graphicsInfo();
    const r = info.resolved;
    const parts = [
      r.shadows === 'off' ? S.cat.shadows + ': ' + S.tier.off : S.cat.shadows + ' ' + GFX.SHADOW_MAP[r.shadows] + '²',
      r.bloom === 'on' ? S.cat.bloom : null,
      r.reflections === 'on' ? S.cat.reflections : null,
      r.antialias === 'off' ? S.cat.antialias + ': ' + S.tier.off : r.antialias.toUpperCase()
    ].filter(Boolean);
    $('gfx-summary').textContent = [info.gpu, parts.join(', '), info.pixels[0] + '×' + info.pixels[1] + ' px'].join(' · ');
    $('gfx-post-note').classList.toggle('hidden', !(info.postFailed || (!info.postAvailable && r.post)));
  }

  return { init: init, sync: sync, refreshSummary: refreshSummary, pickLocale: pickLocale, LOCALES: LOCALES };
});
