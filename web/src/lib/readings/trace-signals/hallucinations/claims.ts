/**
 * Whether a reply says the work is done, with nothing held back. Pure, and
 * read in memory: the reply is never kept. English, German, Spanish, French
 * and Turkish, the languages the reply rules cover (`outcomes/reply-reading.ts`).
 *
 * A claim is a completion word at the start ("Done.", "Erledigt:"), a
 * first-person past action ("I've created…", "He creado…"), a leading past
 * participle ("Archived the project…") or a passive one ("has been sent").
 * An admission anywhere ("couldn't", "failed", "could only", "there was a
 * problem") takes the claim back: a reply that owns up to the failure is not
 * a false report. Words that are ordinary in a reply ("issue", "problem",
 * "but", "only") are not an admission on their own.
 *
 * Only a statement claims: a question ("Should I have created it?"), a
 * condition ("Once I have updated it…") or an instruction ("Complete the
 * form…") does not.
 */

/** A completion word standing alone at the start: "Done.", "Erledigt:", not "Complete the form". */
const DONE =
  /^\s*(?:done|all (?:set|done)|finished|completed?|success|sorted|erledigt|fertig|hecho|listo|c'?est fait|termin[ée]e?|tamamland[ıi]|bitti)(?=\s*(?:[.!,:;—–-]|$))/i;

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
  /\b(?:couldn'?t|could not|can'?t|cannot|unable|failed|fail(?:s|ure)?|didn'?t|did not|wasn'?t|weren'?t|(?:was|were|is|are|has|have|had) not|not able|errors?|however|except|unfortunately|sorry|partial(?:ly)?|some of|(?:could|can|was able to) only|only (?:managed|able|got)|still need|not yet|instead|try again|retry|ran into|there (?:was|were|is|are) (?:an?|some) (?:issue|problem)s?|(?:hit|had|encountered) (?:an?|some) (?:issue|problem)s?)\b|\b(?:konnte nicht|leider|aber|fehler|jedoch|nur)\b|\b(?:no pude|pero|lo siento|perdón|sin embargo|solo)\b|\b(?:je n'ai pas pu|mais|désolée?|erreur|seulement|cependant)\b|\b(?:yapamadım|ancak|ama|hata|maalesef|üzgünüm|sadece)\b/i;

/** A sentence that asks, sets a condition or tells the person what to do. */
const NOT_A_STATEMENT =
  /^\s*(?:if|once|when|after|as soon as|before|unless|until|should|shall|would|could|can|will|do you|did you|want me|please|let me)\b/i;

const sentencesOf = (reply: string): string[] =>
  reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

const claims = (sentence: string): boolean =>
  DONE.test(sentence) ||
  FIRST_PERSON.test(sentence) ||
  LEADING_PARTICIPLE.test(sentence) ||
  PASSIVE.test(sentence) ||
  OTHER_LANGUAGES.test(sentence);

/** The reply claims the work is done, in a statement, and admits nothing. */
export function claimsCompletion(reply: string | null | undefined): boolean {
  if (!reply || reply.trim() === "") return false;
  if (ADMISSION.test(reply)) return false;
  return sentencesOf(reply).some(
    (sentence) => !sentence.endsWith("?") && !NOT_A_STATEMENT.test(sentence) && claims(sentence),
  );
}
