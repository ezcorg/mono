import { createSignal, createResource, For, Show } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import {
  Users,
  Shield,
  Plus,
  Trash2,
  UserPlus,
  X,
  ChevronRight,
} from "lucide-solid";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { api, type TenantSummary, type GroupSummary } from "../lib/api/client";
import { getApiBaseUrl } from "../lib/stores/config";
import { getToken, getTenantId } from "../lib/stores/auth";
import { cn } from "../lib/cn";
import { t } from "../lib/i18n";

interface GroupDetails {
  members: string[];
  permissions: { id: string; effect: string; resource: string }[];
}

export default function AdminPage() {
  const [refreshKey, setRefreshKey] = createSignal(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  // Group details fetched from server
  const [groupDetails, setGroupDetails] = createSignal<Record<string, GroupDetails>>({});

  function getGroupDetails(groupId: string): GroupDetails {
    return groupDetails()[groupId] ?? { members: [], permissions: [] };
  }

  async function fetchGroupDetails(groupId: string) {
    const token = getToken();
    if (!token) return;
    try {
      const [members, permissions] = await Promise.all([
        api.listGroupMembers(getApiBaseUrl(), token, groupId),
        api.listGroupPermissions(getApiBaseUrl(), token, groupId),
      ]);
      setGroupDetails((prev) => ({
        ...prev,
        [groupId]: { members, permissions },
      }));
    } catch {
      // ignore fetch errors
    }
  }

  // ── Data fetching ──

  const [tenants] = createResource(
    () => refreshKey(),
    async () => {
      const token = getToken();
      if (!token) return [];
      try {
        return await api.listTenants(getApiBaseUrl(), token);
      } catch {
        return [];
      }
    },
  );

  const [groups] = createResource(
    () => refreshKey(),
    async () => {
      const token = getToken();
      if (!token) return [];
      try {
        return await api.listGroups(getApiBaseUrl(), token);
      } catch {
        return [];
      }
    },
  );

  // Helper: find tenant display info
  function tenantLabel(id: string): string {
    const tenant = (tenants() ?? []).find((t) => t.id === id);
    return tenant?.email ?? tenant?.display_name ?? id.slice(0, 8);
  }

  // ── Register user dialog ──

  const [registerOpen, setRegisterOpen] = createSignal(false);
  const [regEmail, setRegEmail] = createSignal("");
  const [regPassword, setRegPassword] = createSignal("");
  const [regName, setRegName] = createSignal("");
  const [regError, setRegError] = createSignal("");
  const [regLoading, setRegLoading] = createSignal(false);

  async function handleRegisterUser() {
    if (!regEmail().trim() || !regPassword().trim()) {
      setRegError(t("error_enter_credentials"));
      return;
    }
    setRegLoading(true);
    setRegError("");
    try {
      await api.registerUser(getApiBaseUrl(), getToken() ?? "", {
        email: regEmail(),
        password: regPassword(),
        display_name: regName() || regEmail(),
      });
      setRegisterOpen(false);
      setRegEmail("");
      setRegPassword("");
      setRegName("");
      refresh();
    } catch (err: any) {
      setRegError(err?.body ?? err?.message ?? "Registration failed");
    } finally {
      setRegLoading(false);
    }
  }

  // ── Create group dialog ──

  const [groupOpen, setGroupOpen] = createSignal(false);
  const [groupName, setGroupName] = createSignal("");
  const [groupDesc, setGroupDesc] = createSignal("");
  const [groupError, setGroupError] = createSignal("");

  async function handleCreateGroup() {
    if (!groupName().trim()) return;
    setGroupError("");
    try {
      const token = getToken();
      if (!token) return;
      await api.createGroup(getApiBaseUrl(), token, {
        name: groupName(),
        description: groupDesc() || undefined,
      });
      setGroupOpen(false);
      setGroupName("");
      setGroupDesc("");
      refresh();
    } catch (err: any) {
      setGroupError(err?.body ?? err?.message ?? "Failed to create group");
    }
  }

  // ── Add permission ──

  const [permOpen, setPermOpen] = createSignal(false);
  const [permGroupId, setPermGroupId] = createSignal("");
  const [permEffect, setPermEffect] = createSignal("grant");
  const [permResource, setPermResource] = createSignal("");
  const [permError, setPermError] = createSignal("");

  async function handleAddPermission() {
    if (!permResource().trim()) return;
    setPermError("");
    try {
      const token = getToken();
      if (!token) return;
      await api.addGroupPermission(getApiBaseUrl(), token, permGroupId(), {
        effect: permEffect(),
        resource: permResource(),
      });
      setPermOpen(false);
      setPermResource("");
      await fetchGroupDetails(permGroupId());
    } catch (err: any) {
      setPermError(err?.body ?? err?.message ?? "Failed to add permission");
    }
  }

  async function handleRemovePermission(groupId: string, permId: string) {
    const token = getToken();
    if (!token) return;
    try {
      await api.removeGroupPermission(getApiBaseUrl(), token, groupId, permId);
      await fetchGroupDetails(groupId);
    } catch {
      // ignore
    }
  }

  /** Edit a permission by replacing it (delete + recreate). */
  async function handleEditPermission(
    groupId: string,
    oldPermId: string,
    newEffect: string,
    newResource: string,
  ) {
    const token = getToken();
    if (!token) return;
    try {
      await api.removeGroupPermission(getApiBaseUrl(), token, groupId, oldPermId);
      await api.addGroupPermission(getApiBaseUrl(), token, groupId, {
        effect: newEffect,
        resource: newResource,
      });
      await fetchGroupDetails(groupId);
    } catch {
      // ignore
    }
  }

  // ── Add member ──

  const [memberOpen, setMemberOpen] = createSignal(false);
  const [memberGroupId, setMemberGroupId] = createSignal("");
  const [memberTenantId, setMemberTenantId] = createSignal("");

  async function handleAddMember() {
    if (!memberTenantId().trim()) return;
    try {
      const token = getToken();
      if (!token) return;
      await api.addGroupMember(getApiBaseUrl(), token, memberGroupId(), memberTenantId());
      setMemberOpen(false);
      setMemberTenantId("");
      await fetchGroupDetails(memberGroupId());
    } catch {
      // ignore
    }
  }

  async function handleRemoveMember(groupId: string, tenantId: string) {
    const token = getToken();
    if (!token) return;
    try {
      await api.removeGroupMember(getApiBaseUrl(), token, groupId, tenantId);
      await fetchGroupDetails(groupId);
    } catch {
      // ignore
    }
  }

  // ── Inline actions ──

  const currentTenantId = () => getTenantId();

  async function toggleTenantEnabled(tenant: TenantSummary) {
    const token = getToken();
    if (!token) return;
    try {
      await api.updateTenant(getApiBaseUrl(), token, tenant.id, { enabled: !tenant.enabled });
      refresh();
    } catch {
      // ignore
    }
  }

  async function deleteTenant(id: string) {
    const token = getToken();
    if (!token) return;
    try {
      await api.deleteTenant(getApiBaseUrl(), token, id);
      refresh();
    } catch {
      // ignore
    }
  }

  async function deleteGroup(id: string) {
    const token = getToken();
    if (!token) return;
    try {
      await api.deleteGroup(getApiBaseUrl(), token, id);
      refresh();
    } catch {
      // ignore
    }
  }

  // ── Expanded groups ──

  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());

  function toggleGroupExpanded(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Fetch details from server when expanding
        fetchGroupDetails(id);
      }
      return next;
    });
  }

  // ── Delete confirmation ──
  const [deleteTarget, setDeleteTarget] = createSignal<{ type: "user" | "group"; id: string } | null>(null);

  return (
    <div class="py-6 pb-24 sm:pb-6 space-y-6">
      <div>
        <h2 class="text-2xl font-extrabold font-display">{t("admin_title")}</h2>
        <p class="text-sm text-[rgb(var(--color-text-muted))] font-display">
          {t("admin_subtitle")}
        </p>
      </div>

      {/* ── Users ── */}
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle class="flex items-center gap-2">
                <Users class="h-4 w-4" />
                {t("admin_users_title")}
              </CardTitle>
              <CardDescription>{t("admin_users_desc")}</CardDescription>
            </div>
            <Button size="sm" onClick={() => setRegisterOpen(true)}>
              <UserPlus class="h-3.5 w-3.5" />
              {t("admin_users_add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Show
            when={(tenants() ?? []).length > 0}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">{t("admin_users_empty")}</p>
            }
          >
            <div class="divide-y divide-[rgb(var(--color-border))]">
              <For each={tenants()}>
                {(tenant) => {
                  const isSelf = () => tenant.id === currentTenantId();
                  return (
                    <div class="flex items-center justify-between py-3 gap-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm font-display font-semibold truncate">
                          {tenant.display_name}
                          <Show when={isSelf()}>
                            <span class="text-xs text-[rgb(var(--color-text-muted))] ml-1">(you)</span>
                          </Show>
                        </p>
                        <p class="text-xs text-[rgb(var(--color-text-muted))] truncate">
                          {tenant.email ?? tenant.id}
                        </p>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Badge variant={tenant.enabled ? "success" : "secondary"}>
                          {tenant.enabled ? t("admin_users_enabled") : t("admin_users_disable")}
                        </Badge>
                        {/* Don't let users disable or delete themselves */}
                        <Show when={!isSelf()}>
                          <Switch
                            checked={tenant.enabled}
                            onChange={() => toggleTenantEnabled(tenant)}
                          />
                          <button
                            onClick={() => setDeleteTarget({ type: "user", id: tenant.id })}
                            class="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-text-muted))] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 class="h-3.5 w-3.5" />
                          </button>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>

      {/* ── Groups ── */}
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <div>
              <CardTitle class="flex items-center gap-2">
                <Shield class="h-4 w-4" />
                {t("admin_groups_title")}
              </CardTitle>
              <CardDescription>{t("admin_groups_desc")}</CardDescription>
            </div>
            <Button size="sm" class="whitespace-nowrap shrink-0" onClick={() => setGroupOpen(true)}>
              <Plus class="h-3.5 w-3.5" />
              {t("admin_groups_add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Show
            when={(groups() ?? []).length > 0}
            fallback={
              <p class="text-sm text-[rgb(var(--color-text-muted))]">{t("admin_groups_empty")}</p>
            }
          >
            <div class="space-y-2">
              <For each={groups()}>
                {(group) => {
                  const details = () => getGroupDetails(group.id);
                  return (
                    <div class="rounded-xl border border-[rgb(var(--color-border))] overflow-hidden">
                      <div
                        class="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[rgb(var(--color-surface-hover))] transition-colors"
                        onClick={() => toggleGroupExpanded(group.id)}
                      >
                        <div class="flex-1 min-w-0">
                          <p class="text-sm font-display font-semibold">{group.name}</p>
                          <Show when={group.description}>
                            <p class="text-xs text-[rgb(var(--color-text-muted))] truncate">
                              {group.description}
                            </p>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <Show when={details().members.length > 0}>
                            <Badge variant="secondary" class="text-[10px]">
                              {details().members.length} {t("admin_groups_members").toLowerCase()}
                            </Badge>
                          </Show>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget({ type: "group", id: group.id });
                            }}
                            class="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-text-muted))] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 class="h-3.5 w-3.5" />
                          </button>
                          <div class={cn(
                            "transition-transform duration-200",
                            expandedGroups().has(group.id) && "rotate-90"
                          )}>
                            <ChevronRight class="h-4 w-4 text-[rgb(var(--color-text-muted))]" />
                          </div>
                        </div>
                      </div>

                      <Show when={expandedGroups().has(group.id)}>
                        <div class="px-3 pb-3 pt-2 space-y-4 border-t border-[rgb(var(--color-border))]">
                          {/* Members */}
                          <div>
                            <div class="flex items-center justify-between mb-2">
                              <p class="text-xs font-display font-semibold text-[rgb(var(--color-text-muted))] uppercase tracking-wider">
                                {t("admin_groups_members")}
                              </p>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setMemberGroupId(group.id);
                                  setMemberOpen(true);
                                }}
                              >
                                <Plus class="h-3 w-3" />
                                {t("admin_groups_add_member")}
                              </Button>
                            </div>
                            <Show
                              when={details().members.length > 0}
                              fallback={
                                <p class="text-xs text-[rgb(var(--color-text-muted))] italic">
                                  No members yet
                                </p>
                              }
                            >
                              <div class="space-y-1">
                                <For each={details().members}>
                                  {(memberId) => (
                                    <div class="flex items-center justify-between py-1 px-2 rounded-lg hover:bg-[rgb(var(--color-surface-hover))]">
                                      <span class="text-xs font-display">{tenantLabel(memberId)}</span>
                                      <button
                                        onClick={() => handleRemoveMember(group.id, memberId)}
                                        class="text-[rgb(var(--color-text-muted))] hover:text-red-500 transition-colors"
                                      >
                                        <X class="h-3 w-3" />
                                      </button>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>

                          {/* Permissions */}
                          <div>
                            <div class="flex items-center justify-between mb-2">
                              <p class="text-xs font-display font-semibold text-[rgb(var(--color-text-muted))] uppercase tracking-wider">
                                {t("admin_groups_permissions")}
                              </p>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setPermGroupId(group.id);
                                  setPermOpen(true);
                                }}
                              >
                                <Plus class="h-3 w-3" />
                                {t("admin_groups_add_permission")}
                              </Button>
                            </div>
                            <Show
                              when={details().permissions.length > 0}
                              fallback={
                                <p class="text-xs text-[rgb(var(--color-text-muted))] italic">
                                  No permissions yet
                                </p>
                              }
                            >
                              <div class="space-y-1">
                                <For each={details().permissions}>
                                  {(perm) => {
                                    const [editing, setEditing] = createSignal(false);
                                    const [editResource, setEditResource] = createSignal(perm.resource);
                                    const [editEffect, setEditEffect] = createSignal(perm.effect);
                                    return (
                                      <Show
                                        when={editing()}
                                        fallback={
                                          <div class="flex items-center justify-between py-1 px-2 rounded-lg hover:bg-[rgb(var(--color-surface-hover))]">
                                            <div
                                              class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                                              onClick={() => setEditing(true)}
                                            >
                                              <Badge
                                                variant={perm.effect === "grant" ? "success" : "accent"}
                                                class="text-[10px] shrink-0"
                                              >
                                                {perm.effect}
                                              </Badge>
                                              <span class="text-xs font-mono truncate">{perm.resource}</span>
                                            </div>
                                            <button
                                              onClick={() => handleRemovePermission(group.id, perm.id)}
                                              class="text-[rgb(var(--color-text-muted))] hover:text-red-500 transition-colors shrink-0 ml-1"
                                            >
                                              <X class="h-3 w-3" />
                                            </button>
                                          </div>
                                        }
                                      >
                                        <div class="py-1.5 px-2 rounded-lg bg-[rgb(var(--color-surface-hover))] space-y-1.5">
                                          <div class="flex gap-1.5">
                                            <button
                                              onClick={() => setEditEffect("grant")}
                                              class={cn(
                                                "px-2 py-0.5 rounded text-[10px] font-bold border transition-colors",
                                                editEffect() === "grant"
                                                  ? "border-green-500 bg-green-500/10 text-green-600"
                                                  : "border-transparent text-[rgb(var(--color-text-muted))]"
                                              )}
                                            >
                                              grant
                                            </button>
                                            <button
                                              onClick={() => setEditEffect("deny")}
                                              class={cn(
                                                "px-2 py-0.5 rounded text-[10px] font-bold border transition-colors",
                                                editEffect() === "deny"
                                                  ? "border-red-500 bg-red-500/10 text-red-600"
                                                  : "border-transparent text-[rgb(var(--color-text-muted))]"
                                              )}
                                            >
                                              deny
                                            </button>
                                          </div>
                                          <input
                                            type="text"
                                            value={editResource()}
                                            onInput={(e) => setEditResource(e.currentTarget.value)}
                                            class="w-full rounded border border-[rgb(var(--color-border))] bg-transparent px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-primary))]"
                                          />
                                          <div class="flex justify-end gap-1.5">
                                            <button
                                              onClick={() => setEditing(false)}
                                              class="text-[10px] px-2 py-0.5 rounded text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface))] transition-colors"
                                            >
                                              {t("plugins_cancel")}
                                            </button>
                                            <button
                                              onClick={async () => {
                                                await handleEditPermission(
                                                  group.id,
                                                  perm.id,
                                                  editEffect(),
                                                  editResource(),
                                                );
                                                setEditing(false);
                                              }}
                                              class="text-[10px] px-2 py-0.5 rounded font-semibold text-[rgb(var(--color-primary))] hover:bg-[rgb(var(--color-primary))]/10 transition-colors"
                                            >
                                              {t("common_save")}
                                            </button>
                                          </div>
                                        </div>
                                      </Show>
                                    );
                                  }}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </CardContent>
      </Card>

      {/* ── Register User Dialog ── */}
      <Dialog open={registerOpen()} onOpenChange={setRegisterOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <div class="flex items-center justify-between mb-4">
              <Dialog.Title class="text-lg font-bold font-display">
                {t("admin_users_add")}
              </Dialog.Title>
              <Dialog.CloseButton class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors">
                <X class="h-4 w-4" />
              </Dialog.CloseButton>
            </div>
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>{t("admin_users_email")}</Label>
                <Input
                  type="email"
                  value={regEmail()}
                  onInput={(e) => setRegEmail(e.currentTarget.value)}
                  placeholder="user@example.com"
                />
              </div>
              <div class="space-y-1">
                <Label>{t("admin_users_display_name")}</Label>
                <Input
                  type="text"
                  value={regName()}
                  onInput={(e) => setRegName(e.currentTarget.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div class="space-y-1">
                <Label>{t("admin_users_password")}</Label>
                <Input
                  type="password"
                  value={regPassword()}
                  onInput={(e) => setRegPassword(e.currentTarget.value)}
                  placeholder="••••••••"
                />
              </div>
              <Show when={regError()}>
                <p class="text-xs text-red-500">{regError()}</p>
              </Show>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setRegisterOpen(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button size="sm" onClick={handleRegisterUser} disabled={regLoading()}>
                <UserPlus class="h-3.5 w-3.5" />
                {regLoading() ? t("common_saving") : t("admin_users_add")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* ── Create Group Dialog ── */}
      <Dialog open={groupOpen()} onOpenChange={setGroupOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <div class="flex items-center justify-between mb-4">
              <Dialog.Title class="text-lg font-bold font-display">
                {t("admin_groups_add")}
              </Dialog.Title>
              <Dialog.CloseButton class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors">
                <X class="h-4 w-4" />
              </Dialog.CloseButton>
            </div>
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>{t("admin_groups_name")}</Label>
                <Input
                  type="text"
                  value={groupName()}
                  onInput={(e) => setGroupName(e.currentTarget.value)}
                  placeholder="Administrators"
                />
              </div>
              <div class="space-y-1">
                <Label>{t("admin_groups_description")}</Label>
                <Input
                  type="text"
                  value={groupDesc()}
                  onInput={(e) => setGroupDesc(e.currentTarget.value)}
                  placeholder="Full access to all resources"
                />
              </div>
              <Show when={groupError()}>
                <p class="text-xs text-red-500">{groupError()}</p>
              </Show>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setGroupOpen(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button size="sm" onClick={handleCreateGroup}>
                <Plus class="h-3.5 w-3.5" />
                {t("admin_groups_add")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* ── Add Permission Dialog ── */}
      <Dialog open={permOpen()} onOpenChange={setPermOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <div class="flex items-center justify-between mb-4">
              <Dialog.Title class="text-lg font-bold font-display">
                {t("admin_groups_add_permission")}
              </Dialog.Title>
              <Dialog.CloseButton class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors">
                <X class="h-4 w-4" />
              </Dialog.CloseButton>
            </div>
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>{t("admin_groups_permission_effect")}</Label>
                <div class="flex gap-2">
                  <button
                    onClick={() => setPermEffect("grant")}
                    class={cn(
                      "flex-1 py-2 rounded-xl text-xs font-display font-semibold border transition-colors",
                      permEffect() === "grant"
                        ? "border-green-500 bg-green-500/10 text-green-600"
                        : "border-[rgb(var(--color-border))] text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))]"
                    )}
                  >
                    {t("admin_groups_permission_grant")}
                  </button>
                  <button
                    onClick={() => setPermEffect("deny")}
                    class={cn(
                      "flex-1 py-2 rounded-xl text-xs font-display font-semibold border transition-colors",
                      permEffect() === "deny"
                        ? "border-red-500 bg-red-500/10 text-red-600"
                        : "border-[rgb(var(--color-border))] text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))]"
                    )}
                  >
                    {t("admin_groups_permission_deny")}
                  </button>
                </div>
              </div>
              <div class="space-y-1">
                <Label>{t("admin_groups_permission_resource")}</Label>
                <Input
                  type="text"
                  value={permResource()}
                  onInput={(e) => setPermResource(e.currentTarget.value)}
                  placeholder="tenants:*:read"
                  class="font-mono text-xs"
                />
              </div>
              <Show when={permError()}>
                <p class="text-xs text-red-500">{permError()}</p>
              </Show>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setPermOpen(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button size="sm" onClick={handleAddPermission}>
                <Plus class="h-3.5 w-3.5" />
                {t("admin_groups_add_permission")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* ── Add Member Dialog ── */}
      <Dialog open={memberOpen()} onOpenChange={setMemberOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <div class="flex items-center justify-between mb-4">
              <Dialog.Title class="text-lg font-bold font-display">
                {t("admin_groups_add_member")}
              </Dialog.Title>
              <Dialog.CloseButton class="flex h-8 w-8 items-center justify-center rounded-xl text-[rgb(var(--color-text-muted))] hover:bg-[rgb(var(--color-surface-hover))] transition-colors">
                <X class="h-4 w-4" />
              </Dialog.CloseButton>
            </div>
            <div class="space-y-2">
              <Label>User</Label>
              <div class="space-y-1 max-h-48 overflow-y-auto">
                <For each={tenants() ?? []}>
                  {(tenant) => {
                    const alreadyMember = () =>
                      getGroupDetails(memberGroupId()).members.includes(tenant.id);
                    return (
                      <button
                        disabled={alreadyMember()}
                        onClick={() => setMemberTenantId(tenant.id)}
                        class={cn(
                          "flex items-center gap-2 w-full px-3 py-2 rounded-xl text-left text-xs font-display transition-colors",
                          memberTenantId() === tenant.id
                            ? "bg-[rgb(var(--color-primary))]/10 border border-[rgb(var(--color-primary))]"
                            : alreadyMember()
                              ? "opacity-40 cursor-not-allowed"
                              : "hover:bg-[rgb(var(--color-surface-hover))] border border-transparent"
                        )}
                      >
                        <div class="flex-1 min-w-0">
                          <p class="font-semibold truncate">{tenant.display_name}</p>
                          <p class="text-[rgb(var(--color-text-muted))] truncate">{tenant.email ?? tenant.id}</p>
                        </div>
                        <Show when={alreadyMember()}>
                          <Badge variant="secondary" class="text-[9px]">added</Badge>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setMemberOpen(false)}>
                {t("plugins_cancel")}
              </Button>
              <Button size="sm" onClick={handleAddMember} disabled={!memberTenantId()}>
                <Plus class="h-3.5 w-3.5" />
                {t("admin_groups_add_member")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      {/* ── Delete Confirmation Dialog ── */}
      <Dialog open={!!deleteTarget()} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
          <Dialog.Content class="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-6 shadow-xl animate-fade-in">
            <Dialog.Title class="text-lg font-bold font-display mb-2">
              {deleteTarget()?.type === "user" ? t("admin_users_delete") : t("admin_groups_delete")}
            </Dialog.Title>
            <Dialog.Description class="text-sm text-[rgb(var(--color-text-muted))] mb-6">
              {deleteTarget()?.type === "user" ? t("admin_users_delete_confirm") : t("admin_users_delete_confirm")}
            </Dialog.Description>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
                {t("plugins_cancel")}
              </Button>
              <Button
                size="sm"
                class="bg-red-500 hover:bg-red-600 text-white"
                onClick={() => {
                  const target = deleteTarget();
                  if (!target) return;
                  if (target.type === "user") deleteTenant(target.id);
                  else deleteGroup(target.id);
                  setDeleteTarget(null);
                }}
              >
                <Trash2 class="h-3.5 w-3.5" />
                {deleteTarget()?.type === "user" ? t("admin_users_delete") : t("admin_groups_delete")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
