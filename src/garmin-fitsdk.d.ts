/**
 * Déclarations TypeScript minimales pour @garmin/fitsdk.
 * Le package est un module ESM pur JavaScript sans types fournis.
 */
declare module "@garmin/fitsdk" {
  /** Représente le flux binaire d'un fichier FIT. */
  export class Stream {
    static fromArrayBuffer(buffer: ArrayBuffer): Stream;
    static fromByteArray(bytes: number[]): Stream;
  }

  export interface DecoderReadOptions {
    /** Callback appelé pour chaque message décodé. */
    mesgListener?: (messageNumber: number, message: Record<string, unknown>) => void;
    /** Applique les facteurs d'échelle/offset du profil FIT (recommandé). */
    applyScaleAndOffset?: boolean;
    /** Développe les sous-champs définis dans le profil FIT. */
    expandSubFields?: boolean;
    /** Développe les composants des champs. */
    expandComponents?: boolean;
    /** Convertit les valeurs entières en chaînes selon le profil FIT. */
    convertTypesToStrings?: boolean;
    /** Convertit les timestamps FIT en objets Date JavaScript. */
    convertDateTimesToDates?: boolean;
    /** Inclut les données inconnues (champs non référencés dans le profil). */
    includeUnknownData?: boolean;
    /** Fusionne automatiquement les FC des messages HR dans les records. */
    mergeHeartRates?: boolean;
    /** Décode les memoGlob. */
    decodeMemoGlobs?: boolean;
  }

  /** Décode un fichier FIT depuis un Stream. */
  export class Decoder {
    constructor(stream: Stream);
    /** Vérifie que le stream commence par l'entête FIT (statique). */
    static isFIT(stream: Stream): boolean;
    /** Vérifie que le stream commence par l'entête FIT (instance). */
    isFIT(): boolean;
    /** Vérifie l'intégrité complète du fichier FIT (entête + taille + CRC). */
    checkIntegrity(): boolean;
    /**
     * Décode tous les messages du fichier FIT.
     * @returns messages : dictionnaire {nomTypeMesgs: tableau d'objets message}
     *          errors   : tableau d'erreurs rencontrées (non fatales)
     */
    read(options?: DecoderReadOptions): {
      messages: Record<string, Record<string, unknown>[]>;
      errors: Error[];
    };
  }

  export const Profile: Record<string, unknown>;

  export const Utils: {
    /** Millisecondes entre l'epoch Unix (1970) et l'epoch FIT (1989-12-31). */
    FIT_EPOCH_MS: number;
    /** Convertit un timestamp FIT (entier) en Date JavaScript. */
    convertDateTimeToDate(dateTime: number): Date;
  };
}
