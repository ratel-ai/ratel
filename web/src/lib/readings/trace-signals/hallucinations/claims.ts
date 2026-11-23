/**
 * Whether a reply says the work is done, with nothing held back. Pure, and
 * read in memory: the reply is never kept. English, German, Spanish, French
 * and Turkish, the languages the reply rules cover (`outcomes/reply-reading.ts`).
 *
 * A claim is a completion word at the start ("Done.", "Erledigt:"), a
 * first-person past action ("I've created…", "He creado…"), a leading past
 * participle ("Archived the project…") or a passive one ("has been sent").
 * An admission anywhere ("couldn't", "but", "failed", "only") takes the claim
 * back: a reply that owns up to the failure is not a false report.
 */

const DONE =
  /^\s*(?:done|all (?:set|done)|finished|completed?|success|sorted|erledigt|fertig|hecho|listo|c'?est fait|termin[ée]e?|tamam(?:land[ıi])?|bitti)\b/i;

const PAST =
  "created|updated|sent|added|moved|archived|deleted|removed|tagged|assigned|posted|linked|marked|renamed|scheduled|set|changed|closed|merged|shared|uploaded|saved|restored|notified|commented|completed|cancelled|canceled|published|invited";

const FIRST_PERSON = new RegExp(
  `\\b(?:i|we)(?:'ve| have)?(?: just| already| now)? (?:${PAST})\\b`,
  "i",
);
const LEADING_PARTICIPLE = new RegExp(`^\\s*(?:${PAST})\\b`, "i");
const PASSIVE = new RegExp(
  `\\b(?:has|have) been (?:${PAST})\\b|\\b(?:is|are) (?:now )?(?:${PAST})\\b`,
  "i",
);
const OTHER_LANGUAGES =
  /\b(?:ich habe|habe ich|wurden?|ist jetzt|sind jetzt)\b[^.!?]*\b(?:erstellt|aktualisiert|verschoben|gesendet|hinzugefügt|gelöscht|geschlossen|verknüpft)\b|\bhe (?:creado|actualizado|movido|enviado|añadido|eliminado|cerrado|vinculado|quitado)\b|\bj'ai (?:créé|mis à jour|déplacé|envoyé|ajouté|supprimé|fermé|lié)\b|\b(?:est|sont|a été|ont été) (?:fermée?s?|créée?s?|envoyée?s?|prévenue?s?|mise?s? à jour)\b|\b(?:oluşturdum|güncelledim|taşıdım|gönderdim|ekledim|sildim|kapattım|oluşturuldu|güncellendi|gönderildi|eklendi)\b/i;

const ADMISSION =
  /\b(?:couldn'?t|could not|can'?t|cannot|unable|failed|fail(?:s|ure)?|didn'?t|did not|wasn'?t|weren'?t|not able|errors?|but|however|except|unfortunately|sorry|issue|problem|partial(?:ly)?|some of|only|still need|not yet|instead|try again|retry)\b|\b(?:konnte nicht|leider|aber|fehler|jedoch|nur)\b|\b(?:no pude|pero|lo siento|perdón|sin embargo|solo)\b|\b(?:je n'ai pas pu|mais|désolée?|erreur|seulement|cependant)\b|\b(?:yapamadım|ancak|ama|hata|maalesef|üzgünüm|sadece)\b/i;

/** The reply claims the work is done and admits nothing. */
export function claimsCompletion(reply: string | null | undefined): boolean {
  if (!reply || reply.trim() === "") return false;
  if (ADMISSION.test(reply)) return false;
  return (
    DONE.test(reply) ||
    FIRST_PERSON.test(reply) ||
    LEADING_PARTICIPLE.test(reply) ||
    PASSIVE.test(reply) ||
    OTHER_LANGUAGES.test(reply)
  );
}
