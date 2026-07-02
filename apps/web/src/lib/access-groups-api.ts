import type {
  AccessGroupCreateRequest,
  AccessGroupDetail,
  AccessGroupMembersReplaceRequest,
  AccessGroupSummary,
  AccessGroupUpdateRequest,
  PaginatedResponse,
} from "@rakkr/shared";

import { fetchJson, withQuery } from "./api-http";

const jsonHeaders = { "Content-Type": "application/json" };

// Access-group management client. Kept out of api.ts to stay within the LOC budget;
// spread into the main `api` object so call sites stay `api.createAccessGroup(...)`.
export const accessGroupsApi = {
  accessGroups: (params: { limit?: number; offset?: number } = {}) =>
    fetchJson<PaginatedResponse<AccessGroupSummary>>(withQuery("/api/v1/auth/groups", params)),
  accessGroup: (groupId: string) =>
    fetchJson<{ data: { group: AccessGroupDetail } }>(`/api/v1/auth/groups/${groupId}`),
  createAccessGroup: (input: AccessGroupCreateRequest) =>
    fetchJson<{ data: AccessGroupDetail }>("/api/v1/auth/groups", {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "POST",
    }),
  updateAccessGroup: (groupId: string, input: AccessGroupUpdateRequest) =>
    fetchJson<{ data: AccessGroupDetail }>(`/api/v1/auth/groups/${groupId}`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PATCH",
    }),
  updateAccessGroupMembers: (groupId: string, input: AccessGroupMembersReplaceRequest) =>
    fetchJson<{ data: AccessGroupDetail }>(`/api/v1/auth/groups/${groupId}/members`, {
      body: JSON.stringify(input),
      headers: jsonHeaders,
      method: "PUT",
    }),
  deleteAccessGroup: (groupId: string) =>
    fetchJson<void>(`/api/v1/auth/groups/${groupId}`, { method: "DELETE" }),
};
