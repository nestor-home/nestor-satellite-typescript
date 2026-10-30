/**
 * The SDK's Fluent catalogues (https://projectfluent.org): every sentence a person may read or hear
 * from a satellite. Kept as strings so the catalogue ships in every bundle, with no file to load.
 * `test/i18n.test.ts` checks that every locale has every message.
 */

export const en = `
device-code-log = Pairing code: { $code }. Type it in Nestor to add this device.
device-code-display = Type this code in Nestor to add this device.
# The bundled voice has a clip for each piece of text around the digits (nestor-satellite-python's
# scripts/voice.py records them): record them again after changing this sentence.
device-code-speech = Pairing code: { $digits }. I repeat: { $digits }.
headless-hint = This device has no screen and no voice, so the easiest way to pair it is an enrollment code. Add a satellite in Nestor, then set NESTOR_PAIRING_URI.
enrollment-sent = Sending the enrollment code { $code } to Nestor.
enrollment-refused = { $reason ->
    [expired] The enrollment code { $code } has expired.
    [used] The enrollment code { $code } was already used.
    [cancelled] The enrollment code { $code } was cancelled.
   *[unknown] Nestor does not know the enrollment code { $code }.
}
enrollment-fallback = Asking for a pairing code instead.
enrollment-already-refused = The enrollment code { $code } was already refused. Make a new one in Nestor.
enrollment-invalid = This is not an enrollment code. One has 8 letters and digits, like K7QF-2M9X.
enrollment-not-pending = This device no longer waits for an enrollment code.
paired = Paired with Nestor.
pairing-expired = The pairing code expired. Asking for a new one.
identify = Nestor asks this device to show itself.
too-many-attempts = Too many wrong codes were tried. Trying again in { $seconds } s.
too-many-pending = Too many devices are waiting to be paired. Trying again in { $seconds } s.
protocol-unsupported = This Nestor speaks another version of the satellite protocol. Update this device or Nestor.
invalid-request = Nestor refused this device's pairing request. Update this device or Nestor.
token-refused = Nestor no longer knows this device. Pairing it again.
link-failed = The link to Nestor failed ({ $error }). Trying again.
camera-failed = The camera did not open, so this device cannot scan a QR code ({ $error }).
`;

export const fr = `
device-code-log = Code d'appairage : { $code }. Saisissez-le dans Nestor pour ajouter cet appareil.
device-code-display = Saisissez ce code dans Nestor pour ajouter cet appareil.
# La voix fournie a un extrait pour chaque texte autour des chiffres (scripts/voice.py de
# nestor-satellite-python les enregistre) : les réenregistrer après avoir changé cette phrase.
device-code-speech = Code d'appairage : { $digits }. Je répète : { $digits }.
headless-hint = Cet appareil n'a ni écran ni voix : le plus simple est de l'appairer avec un code d'enrôlement. Ajoutez un satellite dans Nestor, puis renseignez NESTOR_PAIRING_URI.
enrollment-sent = Envoi du code d'enrôlement { $code } à Nestor.
enrollment-refused = { $reason ->
    [expired] Le code d'enrôlement { $code } a expiré.
    [used] Le code d'enrôlement { $code } a déjà servi.
    [cancelled] Le code d'enrôlement { $code } a été annulé.
   *[unknown] Nestor ne connaît pas le code d'enrôlement { $code }.
}
enrollment-fallback = Je demande un code d'appairage à la place.
enrollment-already-refused = Le code d'enrôlement { $code } a déjà été refusé. Créez-en un nouveau dans Nestor.
enrollment-invalid = Ce n'est pas un code d'enrôlement. Il compte 8 lettres et chiffres, comme K7QF-2M9X.
enrollment-not-pending = Cet appareil n'attend plus de code d'enrôlement.
paired = Appairé avec Nestor.
pairing-expired = Le code d'appairage a expiré. J'en demande un nouveau.
identify = Nestor demande à cet appareil de se signaler.
too-many-attempts = Trop de codes erronés ont été essayés. Nouvel essai dans { $seconds } s.
too-many-pending = Trop d'appareils attendent d'être appairés. Nouvel essai dans { $seconds } s.
protocol-unsupported = Ce Nestor parle une autre version du protocole des satellites. Mettez à jour cet appareil ou Nestor.
invalid-request = Nestor a refusé la demande d'appairage de cet appareil. Mettez à jour cet appareil ou Nestor.
token-refused = Nestor ne connaît plus cet appareil. Nouvel appairage.
link-failed = La liaison avec Nestor a échoué ({ $error }). Nouvel essai.
camera-failed = La caméra ne s'est pas ouverte : cet appareil ne peut pas lire de QR code ({ $error }).
`;

/** The messages every catalogue has. */
export type MessageId =
  | "device-code-log"
  | "device-code-display"
  | "device-code-speech"
  | "headless-hint"
  | "enrollment-sent"
  | "enrollment-refused"
  | "enrollment-fallback"
  | "enrollment-already-refused"
  | "enrollment-invalid"
  | "enrollment-not-pending"
  | "paired"
  | "pairing-expired"
  | "identify"
  | "too-many-attempts"
  | "too-many-pending"
  | "protocol-unsupported"
  | "invalid-request"
  | "token-refused"
  | "link-failed"
  | "camera-failed";
