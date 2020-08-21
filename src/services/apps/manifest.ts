import { SemverVersion } from '../service'

/**
 * Matrix App manifest
 */
namespace AppManifest {
  /**
   * The base manifest; This just contains a (major) version
   */
  export interface Base {
    manifest_version: number
  }

  export type LocalizedObject = { [locale: string]: string }
  export namespace LocalizedObject {
    export function getLocalized(
      obj: LocalizedObject,
      ...locales: string[]
    ): string | undefined {
      const keys = Object.keys(obj)
      if (!keys.length) {
        return undefined
      }

      for (const locale of locales) {
        // Try the locale first (ex, `en-US`)
        if (obj[locale]) {
          return obj[locale]
        }

        // Try the first part of the locale (ex, `en`)
        const splitdown = locale.split('-')[0]
        if (obj[splitdown]) {
          return obj[splitdown]
        }

        // Try any locale that starts with the same first part (ex, `en-*`)
        const samestart = keys.filter((k) => k.startsWith(splitdown))
        if (samestart.length) {
          return obj[samestart[0]]
        }
      }

      // Everything else has failed; Return any available translation
      return obj[keys[0]]
    }
    export const Schema = {
      type: 'object',
      additionalProperties: { type: 'string' }
    }
  }

  /**
   * Version 0 of the manifest
   */
  export interface V0 extends Base {
    manifest_version: 0

    /**
     * IETF language tag for the default language to use when returning text
     * from this manifest.
     */
    default_locale?: string
    /**
     * Localized application title
     */
    title: LocalizedObject
    /**
     * Localized application description
     */
    description?: LocalizedObject
    /**
     * Application version
     */
    version: SemverVersion

    /**
     * Application entry points. These are used when the application is
     * launched to determine the URL to open. The keys are namespaced using the
     * Java package naming convention.
     */
    entry_points: {
      [context: string]: {
        /**
         * The URL to load, which first has substitutions performed then it
         * opened in a new tab. The substitutions are as follows:
         * * `{{return}}` - The URL to `iframe` to establish a communication
         * channel with the worker
         */
        to: string
      }
      /**
       * For opening rooms with a particular application (ex, collaborative
       * document, ban list, etc.)
       */
      ['net.kb1rd.openroom']: {
        to: string
        /**
         * Types of rooms that can be associated and opened with this
         * application. (ex, `net.kb1rd.plaintext`)
         */
        types: string[]
      }
    }

    /**
     * Permissions to request on installation
     */
    request_permissions: string[]
  }
  export namespace V0 {
    export const Schema = {
      type: 'object',
      properties: {
        manifest_version: { type: 'number', minimum: 0, maximum: 0 },
        default_locale: { type: 'string' },
        title: LocalizedObject.Schema,
        version: SemverVersion.Schema,
        description: LocalizedObject.Schema,
        entry_points: {
          type: 'object',
          properties: {
            'net.kb1rd.openroom': {
              type: 'object',
              properties: {
                to: { type: 'string' },
                types: { type: 'array', items: { type: 'string' } }
              },
              required: ['to']
            }
          },
          additionalProperties: {
            type: 'object',
            properties: {
              to: { type: 'string' }
            },
            required: ['to']
          }
        },
        request_permissions: { type: 'array', items: { type: 'string' } }
      },
      required: [
        'manifest_version',
        'title',
        'version',
        'entry_points',
        'request_permissions'
      ]
    }
  }

  /**
   * Any version of manifest supported
   */
  export type Known = V0
  export namespace Known {
    export const Schema = {
      type: 'object',
      oneOf: [V0.Schema]
    }
  }
}

export default AppManifest
