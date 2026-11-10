import { ContextMessage, NextContextStart, TimestampSeparator } from "../components/RecentContext";
import { DirectThreadCard } from "../components/DirectThreadCard";
import { Switch } from "../components/ui/switch";
import { ConnectionLoading } from "../components/ui/connection-loading";
import { ConversationStatus } from "../components/ConversationStatus";
import { clerkAppearance } from "../theme/clerk";
import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "../components/ui/toast";
import { IconButton } from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarSearch } from "../components/SidebarSearch";
import { AgentDiscordLink } from "../components/AgentIdentity";
import { now, directThreadDemos, Section, Specimen } from "./shared";

export function Controls() {
  const [discordId, setDiscordId] = useState("");
  const [savedDiscordId, setSavedDiscordId] = useState("");
  const [search, setSearch] = useState("");
  const [model, setModel] = useState<string | null>("balanced");
  return (
    <Section id="controls" title="Controls">
      <Specimen title="Switches">
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2">
            <Switch /> Off
          </label>
          <label className="flex items-center gap-2">
            <Switch defaultChecked /> On
          </label>
          <label className="flex items-center gap-2">
            <Switch size="sm" defaultChecked /> Small
          </label>
          <label className="flex items-center gap-2">
            <Switch disabled /> Disabled off
          </label>
          <label className="flex items-center gap-2">
            <Switch disabled defaultChecked /> Disabled on
          </label>
        </div>
      </Specimen>
      <Specimen title="Buttons">
        <div className="ds-row flex items-center flex-wrap gap-2">
          {(
            [
              "default",
              "secondary",
              "reference",
              "outline",
              "ghost",
              "destructive",
              "link",
            ] as const
          ).map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button disabled>Disabled</Button>
          <IconButton label="New conversation">
            <Plus />
          </IconButton>
        </div>
        <div className="ds-row flex items-center flex-wrap gap-2">
          {(["xs", "sm", "default", "lg"] as const).map((size) => (
            <Button key={size} size={size} variant="secondary">
              {size}
            </Button>
          ))}
        </div>
      </Specimen>
      <div className="ds-grid grid grid-cols-1 workspace:grid-cols-2 gap-6">
        <Specimen title="Inputs">
          <label className="ds-field flex flex-col gap-2 text-sm">
            Conversation title
            <Input placeholder="Untitled conversation" />
          </label>
          <div className="ds-field flex flex-col gap-2 text-sm">
            <span>Search</span>
            <SidebarSearch label="Search conversations" onSearch={setSearch} />
            {directThreadDemos.map((thread, index) => (
              <DirectThreadCard
                key={thread.displayStatus ?? "idle"}
                thread={thread}
                selected={index === 0}
                now={now}
                onSelect={() => {}}
              />
            ))}
            <TimestampSeparator at={now - 7_200_000} />
            <p className="px-6 text-sm">Earlier conversation.</p>
            <TimestampSeparator at={now - 1_800_000} contextStart />
            <ContextMessage summarized>
              <p className="px-6 text-sm">Earlier conversation, represented in the summary.</p>
            </ContextMessage>
            <NextContextStart />
            <span className="ds-muted" role="status">
              {search ? `Search: ${search}` : ""}
            </span>
          </div>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Disabled
            <Input disabled value="Unavailable" readOnly />
          </label>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Invalid
            <Input aria-invalid defaultValue="Needs a name" />
          </label>
          <label className="ds-field flex flex-col gap-2 text-sm">
            Plain text
            <Textarea placeholder="Write a note…" />
          </label>
        </Specimen>
        <Specimen title="Agent Discord identity">
          <AgentDiscordLink
            value={discordId}
            savedValue={savedDiscordId}
            disabled={false}
            onChange={setDiscordId}
            onSave={() => setSavedDiscordId(discordId.trim())}
          />
        </Specimen>
        <Specimen title="Reconnecting">
          <div className="login-shell flex flex-col gap-6 py-12">
            <h1>Lilac</h1>
            <ConnectionLoading />
          </div>
        </Specimen>
        <Specimen title="Conversation status">
          <div className="grid gap-4 sm:grid-cols-3">
            <ConversationStatus state="loading" />
            <ConversationStatus state="offline" onRetry={() => toast.add({ title: "Retrying" })} />
            <ConversationStatus
              state="error"
              detail="Conversation not found"
              onRetry={() => toast.add({ title: "Retrying" })}
            />
          </div>
        </Specimen>
        <Specimen title="Sign-in styles">
          <div className={clerkAppearance.signIn.elements.cardBox}>
            <div className={`flex flex-col ${clerkAppearance.signIn.elements.card}`}>
              <div className="space-y-2 text-center">
                <h3 className={clerkAppearance.elements.headerTitle}>Enter your password</h3>
                <p className={clerkAppearance.elements.headerSubtitle}>alex@example.com</p>
              </div>
              <label className="flex flex-col gap-2 text-sm">
                Password
                <Input type="password" autoComplete="off" placeholder="Enter your password" />
              </label>
              <Button type="button" className={clerkAppearance.elements.formButtonPrimary}>
                Continue
              </Button>
            </div>
          </div>
        </Specimen>
        <Specimen title="Select & tabs">
          <Select
            value={model}
            onValueChange={setModel}
            items={[
              { value: "balanced", label: "Balanced" },
              { value: "deep", label: "Deep thinking" },
            ]}
          >
            <SelectTrigger aria-label="Example response model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="deep">Deep thinking</SelectItem>
            </SelectContent>
          </Select>
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="appearance">Appearance</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general">General settings content.</TabsContent>
            <TabsContent value="appearance">Appearance settings content.</TabsContent>
          </Tabs>
          <Tabs defaultValue="chat">
            <TabsList variant="line">
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
            </TabsList>
            <TabsContent value="chat">Conversation content.</TabsContent>
            <TabsContent value="files">Shared files.</TabsContent>
          </Tabs>
          <Tabs
            defaultValue="account"
            orientation="vertical"
            className="rounded-lg bg-surface-raised p-4 text-surface-raised-foreground"
          >
            <TabsList activateOnFocus variant="navigation" aria-label="Settings sections">
              <TabsTrigger tabIndex={0} value="account">
                Account
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="options">
                Settings
              </TabsTrigger>
              <TabsTrigger tabIndex={0} value="keybindings">
                Keybindings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="account">Account settings.</TabsContent>
            <TabsContent value="options">
              Appearance, thread, notification, and access settings.
            </TabsContent>
            <TabsContent value="keybindings">Keyboard shortcuts.</TabsContent>
          </Tabs>
        </Specimen>
      </div>
    </Section>
  );
}
