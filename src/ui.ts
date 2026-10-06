import * as clack from "@clack/prompts";
import { CANCELLED, type AgentRequest, type Cancellable, type Ui } from "./add.js";
import type { SkillEntry } from "./registry.js";
import { printable, redact } from "./source.js";

function settle<T>(value: T | symbol): Cancellable<T> {
  return clack.isCancel(value) ? CANCELLED : (value as T);
}

function show(text: string): string {
  return redact(printable(text));
}

function hint(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function clackUi(): Ui {
  return {
    intro: (title) => clack.intro(show(title)),
    step: (message) => clack.log.step(show(message)),
    info: (message) => clack.log.info(show(message)),
    warn: (message) => clack.log.warn(show(message)),
    error: (message) => clack.log.error(show(message)),
    message: (message) => clack.log.message(show(message)),
    note: (body, title) => clack.note(show(body), show(title)),
    cancel: (message) => clack.cancel(show(message)),
    outro: (message) => clack.outro(show(message)),
    async selectSkills(skills: SkillEntry[]) {
      const chosen = settle<string[]>(
        await clack.multiselect({
          message: show("Select skills to install"),
          options: skills.map((skill) => ({ value: skill.name, label: show(skill.name), hint: hint(show(skill.description)) })),
          required: true,
        }),
      );
      return chosen === CANCELLED ? CANCELLED : skills.filter((skill) => chosen.includes(skill.name));
    },
    async selectAgents(request: AgentRequest) {
      if (request.locked.length > 0) {
        clack.log.info(show(`Universal (.agents/skills), always included: ${request.locked.map((agent) => agent.displayName).join(", ")}`));
      }
      return settle<string[]>(
        await clack.autocompleteMultiselect({
          message: show("Which agents do you want to install to?"),
          options: request.choices.map((agent) => ({ value: agent.id, label: show(agent.displayName), hint: show(agent.skillsDir) })),
          initialValues: request.initial,
          required: request.locked.length === 0,
          placeholder: show("Type to search"),
        }),
      );
    },
    async selectScope() {
      return settle<boolean>(
        await clack.select({
          message: show("Installation scope"),
          options: [
            { value: false, label: show("Project"), hint: show("Install in the current directory") },
            { value: true, label: show("Global"), hint: show("Install in your home directory") },
          ],
        }),
      );
    },
    async confirm(message: string) {
      return settle<boolean>(await clack.confirm({ message: show(message) }));
    },
  };
}
