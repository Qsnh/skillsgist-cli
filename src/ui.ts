import * as clack from "@clack/prompts";
import { CANCELLED, type AgentRequest, type Cancellable, type Ui } from "./add.js";
import type { SkillEntry } from "./registry.js";
import { redact } from "./source.js";

function settle<T>(value: T | symbol): Cancellable<T> {
  return clack.isCancel(value) ? CANCELLED : (value as T);
}

function hint(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function clackUi(): Ui {
  return {
    intro: (title) => clack.intro(redact(title)),
    step: (message) => clack.log.step(redact(message)),
    info: (message) => clack.log.info(redact(message)),
    warn: (message) => clack.log.warn(redact(message)),
    error: (message) => clack.log.error(redact(message)),
    message: (message) => clack.log.message(redact(message)),
    note: (body, title) => clack.note(redact(body), redact(title)),
    cancel: (message) => clack.cancel(redact(message)),
    outro: (message) => clack.outro(redact(message)),
    async selectSkills(skills: SkillEntry[]) {
      const chosen = settle<string[]>(
        await clack.multiselect({
          message: redact("Select skills to install"),
          options: skills.map((skill) => ({ value: skill.name, label: redact(skill.name), hint: hint(redact(skill.description)) })),
          required: true,
        }),
      );
      return chosen === CANCELLED ? CANCELLED : skills.filter((skill) => chosen.includes(skill.name));
    },
    async selectAgents(request: AgentRequest) {
      if (request.locked.length > 0) {
        clack.log.info(redact(`Universal (.agents/skills), always included: ${request.locked.map((agent) => agent.displayName).join(", ")}`));
      }
      return settle<string[]>(
        await clack.autocompleteMultiselect({
          message: redact("Which agents do you want to install to?"),
          options: request.choices.map((agent) => ({ value: agent.id, label: redact(agent.displayName), hint: redact(agent.skillsDir) })),
          initialValues: request.initial,
          required: request.locked.length === 0,
          placeholder: redact("Type to search"),
        }),
      );
    },
    async selectScope() {
      return settle<boolean>(
        await clack.select({
          message: redact("Installation scope"),
          options: [
            { value: false, label: redact("Project"), hint: redact("Install in the current directory") },
            { value: true, label: redact("Global"), hint: redact("Install in your home directory") },
          ],
        }),
      );
    },
    async confirm(message: string) {
      return settle<boolean>(await clack.confirm({ message: redact(message) }));
    },
  };
}
