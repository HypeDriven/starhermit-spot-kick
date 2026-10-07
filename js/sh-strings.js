'use strict';

/*
 * Spot Kick — localized strings for the StarHermit account controls
 * (sign-in, invite link, sign-out notice, session expired). Locale follows navigator.language
 * through the Graphics panel's picker. Browser global: window.SpotKickShStrings.
 */
(function (root) {
  const EN = {
    signIn: 'Sign in with StarHermit',
    invite: 'Invite a friend',
    copied: 'Invite link copied',
    copyFailed: 'Could not copy the invite link',
    signedOut: 'Signed out of StarHermit — progress stays on this device',
    expiredTitle: 'Your session expired',
    expiredBody: 'Your StarHermit session ended, so the match connection stopped. Go back to StarHermit to start a fresh session.',
    relaunch: 'Back to StarHermit',
    playLocal: 'Play on this device',
    lbPosting: 'Posting score to the leaderboard…',
    lbRank: 'Leaderboard rank: #{rank}',
    lbPosted: 'Score posted to the leaderboard.',
    lbFailed: 'Score not posted to the leaderboard.'
  };
  const ES = {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    copied: 'Enlace de invitación copiado',
    copyFailed: 'No se pudo copiar el enlace de invitación',
    signedOut: 'Sesión de StarHermit cerrada: el progreso se queda en este dispositivo',
    expiredTitle: 'Tu sesión expiró',
    expiredBody: 'Tu sesión de StarHermit terminó y se detuvo la conexión con el partido. Vuelve a StarHermit para iniciar una nueva sesión.',
    relaunch: 'Volver a StarHermit',
    playLocal: 'Jugar en este dispositivo',
    lbPosting: 'Publicando la puntuación en la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación publicada en la clasificación.',
    lbFailed: 'No se publicó la puntuación en la clasificación.'
  };
  const FR = {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    copied: 'Lien d’invitation copié',
    copyFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit — la progression reste sur cet appareil',
    expiredTitle: 'Votre session a expiré',
    expiredBody: 'Votre session StarHermit est terminée, la connexion au match a donc été interrompue. Retournez sur StarHermit pour démarrer une nouvelle session.',
    relaunch: 'Retour à StarHermit',
    playLocal: 'Jouer sur cet appareil',
    lbPosting: 'Envoi du score au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Score envoyé au classement.',
    lbFailed: 'Score non envoyé au classement.'
  };
  const STRINGS = {
    'en-US': EN, 'en-GB': EN, 'es-419': ES, 'es-ES': ES,
    'de-DE': {
      signIn: 'Mit StarHermit anmelden',
      invite: 'Freund einladen',
      copied: 'Einladungslink kopiert',
      copyFailed: 'Einladungslink konnte nicht kopiert werden',
      signedOut: 'Von StarHermit abgemeldet – der Fortschritt bleibt auf diesem Gerät',
      expiredTitle: 'Deine Sitzung ist abgelaufen',
      expiredBody: 'Deine StarHermit-Sitzung ist beendet, daher wurde die Verbindung zum Spiel getrennt. Kehre zu StarHermit zurück, um eine neue Sitzung zu starten.',
      relaunch: 'Zurück zu StarHermit',
      playLocal: 'Auf diesem Gerät spielen',
      lbPosting: 'Punktzahl wird in die Bestenliste eingetragen…',
      lbRank: 'Platz in der Bestenliste: #{rank}',
      lbPosted: 'Punktzahl in die Bestenliste eingetragen.',
      lbFailed: 'Punktzahl nicht in die Bestenliste eingetragen.'
    },
    'fr-FR': FR,
    'fr-CA': Object.assign({}, FR, { invite: 'Inviter un ami ou une amie', lbPosting: 'Envoi du pointage au classement…', lbPosted: 'Pointage envoyé au classement.', lbFailed: 'Pointage non envoyé au classement.' }),
    'pt-BR': {
      signIn: 'Entrar com StarHermit',
      invite: 'Convidar um amigo',
      copied: 'Link de convite copiado',
      copyFailed: 'Não foi possível copiar o link de convite',
      signedOut: 'Sessão do StarHermit encerrada — o progresso fica neste dispositivo',
      expiredTitle: 'Sua sessão expirou',
      expiredBody: 'Sua sessão do StarHermit terminou e a conexão com a partida foi interrompida. Volte ao StarHermit para iniciar uma nova sessão.',
      relaunch: 'Voltar ao StarHermit',
      playLocal: 'Jogar neste dispositivo',
      lbPosting: 'Enviando a pontuação para o ranking…',
      lbRank: 'Posição no ranking: #{rank}',
      lbPosted: 'Pontuação enviada para o ranking.',
      lbFailed: 'Pontuação não enviada para o ranking.'
    },
    'it-IT': {
      signIn: 'Accedi con StarHermit',
      invite: 'Invita un amico',
      copied: 'Link di invito copiato',
      copyFailed: 'Impossibile copiare il link di invito',
      signedOut: 'Disconnesso da StarHermit: i progressi restano su questo dispositivo',
      expiredTitle: 'La tua sessione è scaduta',
      expiredBody: 'La tua sessione StarHermit è terminata, quindi la connessione alla partita si è interrotta. Torna su StarHermit per avviare una nuova sessione.',
      relaunch: 'Torna a StarHermit',
      playLocal: 'Gioca su questo dispositivo',
      lbPosting: 'Invio del punteggio alla classifica…',
      lbRank: 'Posizione in classifica: #{rank}',
      lbPosted: 'Punteggio inviato alla classifica.',
      lbFailed: 'Punteggio non inviato alla classifica.'
    }
  };
  function strings(lang) {
    const panel = root.SpotKickGfxPanel;
    const key = panel ? panel.pickLocale(lang) : 'en-US';
    return STRINGS[key] || EN;
  }
  const api = { STRINGS: STRINGS, strings: strings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpotKickShStrings = api;
})(typeof self !== 'undefined' ? self : this);
