import { AddressMap, AccessPolicy } from "rpcchannel"

type Permission = {
  /**
   * Grant this particular permission on an application.
   * @param map The permission map to apply changes to
   * @param opts Contains:
   * - `account` - The ID of the account to grant permissions on
   * - `id` - The ID of the application being given the permission
   */
  grantOn(map: AddressMap<AccessPolicy>, opts: { account: string, id: string }): void
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
   * Permission to get room display information (name, avatar, aliases)
   */
  ['net.kb1rd.mxbindings.room.displayinfo']: {
    grantOn(map, { account, id }) {
      // TODO
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
  ['net.kb1rd.mxbindings.room.getstate']: {
    grantOn(map, { account }) {
      const set = (policy: AccessPolicy, name?: string) => map.put(
        [...mxb0_base, account, 'state', name, 'listen'],
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
  ['net.kb1rd.mxbindings.room.setstate']: {
    grantOn(map, { account }) {
      const set = (policy: AccessPolicy, name?: string) => map.put(
        [...mxb0_base, account, 'state', name, 'set'],
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
    inherits: ['net.kb1rd.mxbindings.room.getstate']
  }
}

const available_permissions: PermissionTable = {
  ...mxbindings_permissions
}

export default available_permissions