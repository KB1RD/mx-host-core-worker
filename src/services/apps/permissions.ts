import { AddressMap, AccessPolicy } from 'rpcchannel'

export namespace Context {
  export type Base = {
    /**
     * Account ID to grant access to
     */
    account_id?: string
    /**
     * Application being given access
     */
    app_url?: string
    /**
     * Room being given access to (if any)
     */
    room_id?: string

    /**
     * Namespaced contexts are allowed
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
  }
  export namespace Base {
    export const Schema = {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        app_id: { type: 'string' },
        room_id: { type: 'string' }
      }
    }
  }
  export const Schema = {
    ...Base.Schema,
    required: ['account_id', 'app_id']
  }
}

export interface Context extends Context.Base {
  account_id: string
  app_url: string
}

export type Permission = {
  /**
   * Grant this particular permission on an application.
   * @param map The permission map to apply changes to
   * @param ctx Context to provide to the permission system
   */
  grantOn(map: AddressMap<AccessPolicy>, ctx: Context): void
  /**
   * Permissions that this permission inherits. When this permission is
   * granted, these permissions will be granted as well.
   */
  inherits: string[]
}

type PermissionTable = { [id: string]: Permission }

const mxb0_base = ['net', 'kb1rd', 'mxbindings', 'v0']
const mxbindings_permissions: PermissionTable = {
  /**
   * A default permission to request services
   */
  ['a.services.request']: {
    grantOn(map) {
      map.put(
        ['net', 'kb1rd', 'services', 'requestServices'],
        AccessPolicy.ALLOW
      )
    },
    inherits: []
  },

  /**
   * Permission to get room display information (name, avatar, aliases)
   */
  ['a.openroom.displayinfo']: {
    grantOn(map, { room_id }) {
      if (!room_id) {
        throw new TypeError(
          'Tried to grant room permissions in context without room'
        )
      }
    },
    inherits: []
  },

  /**
   * Permission to get room state with the following exceptions:
   * * m.room.member
   * * m.room.power_levels
   * * m.room.third_party_invite
   * * m.room.server_acl
   */
  ['a.openroom.state.get']: {
    grantOn(map, { account_id, room_id }) {
      if (!room_id) {
        throw new TypeError(
          'Tried to grant room permissions in context without room'
        )
      }
      const set = (policy: AccessPolicy, name?: string) =>
        map.put(
          [...mxb0_base, account_id, 'room', room_id, 'state', name, 'listen'],
          policy
        )
      set(AccessPolicy.ALLOW, undefined)
      set(AccessPolicy.DENY, 'm.room.member')
      set(AccessPolicy.DENY, 'm.room.power_levels')
      set(AccessPolicy.DENY, 'm.room.third_party_invite')
      set(AccessPolicy.DENY, 'm.room.server_acl')
    },
    inherits: []
  },
  /**
   * Permission to set room state with the following exceptions:
   * * m.room.join_rules
   * * m.room.member
   * * m.room.power_levels
   * * m.room.history_visibility
   * * m.room.third_party_invite
   * * m.room.guest_access
   * * m.room.server_acl
   * * m.room.tombstone
   */
  ['a.openroom.state.set']: {
    grantOn(map, { account_id, room_id }) {
      if (!room_id) {
        throw new TypeError(
          'Tried to grant room permissions in context without room'
        )
      }
      const set = (policy: AccessPolicy, name?: string) =>
        map.put(
          [...mxb0_base, account_id, 'room', room_id, 'state', name, 'set'],
          policy
        )
      set(AccessPolicy.ALLOW, undefined)
      set(AccessPolicy.DENY, 'm.room.join_rules')
      set(AccessPolicy.DENY, 'm.room.member')
      set(AccessPolicy.DENY, 'm.room.power_levels')
      set(AccessPolicy.DENY, 'm.room.history_visibility')
      set(AccessPolicy.DENY, 'm.room.third_party_invite')
      set(AccessPolicy.DENY, 'm.room.guest_access')
      set(AccessPolicy.DENY, 'm.room.server_acl')
      set(AccessPolicy.DENY, 'm.room.tombstone')
    },
    inherits: ['a.openroom.state.get']
  }
}

const available_permissions: PermissionTable = {
  ...mxbindings_permissions
}

export default available_permissions
