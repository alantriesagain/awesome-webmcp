// widecode's own tools for an agent that lacks them (api.tools, served over MCP): AskUser puts
// questions with choices to the user in the request panel, PresentPlan puts a plan there to
// approve. Approved in plan mode, the agent leaves it and a message asks it to carry the plan out
// once its turn ends (an ACP agent's mode holds for its next prompt). An agent with tools of its
// own for these (Claude Code's AskUserQuestion and ExitPlanMode) keeps them: its plugin does not
// offer widecode's. Its section names them: { "names": { "question": "AskUser", "plan": "PresentPlan" } }.

const NAMES = { question: "AskUser", plan: "PresentPlan" };

const { list, obj, str } = widecode.util;

const QUESTIONS = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, whole." },
          header: { type: "string", description: "A short label for it (12 characters at most)." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: { label: { type: "string", description: "The choice, in a few words." }, description: { type: "string", description: "What choosing it means." } },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Whether the user may choose several." },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
};

const PLAN = {
  type: "object",
  properties: { plan: { type: "string", description: "The whole plan, in markdown." } },
  required: ["plan"],
};

/** What the user answered, for the agent. */
const answered = (reply: widecode.AgentReply): string => {
  if (reply.state === "cancelled") return "The question was withdrawn before the user answered.";
  if (reply.state !== "answered") return reply.message.length > 0 ? reply.message : "The user did not answer.";
  const lines = reply.answers.map((a) => JSON.stringify(a.question) + ": " + (a.text.length > 0 ? a.text : a.labels.join(", ")));
  return "The user answered:\n" + lines.join("\n");
};

widecode.plugin({
  id: "ask",
  defaults: () => ({ names: NAMES }),
  activate(api) {
    const names = obj(obj(api.settings.section())?.names);
    const named = (key: "question" | "plan"): string => (str(names?.[key]).length > 0 ? str(names?.[key]) : NAMES[key]);
    api.tools.add({
      name: named("question"),
      category: "question",
      except: ["claude"],
      description:
        "Ask the user questions and wait for the answers. Each question offers 2 to 4 choices; the user picks one (several when multiSelect is true) or answers in their own words. Use it when you need the user's decision, or something only they know, before going on. Related questions go in one call.",
      input: QUESTIONS,
      call: async (args) => {
        const questions = list(args.questions)
          .map(obj)
          .filter((q): q is Record<string, unknown> => q !== null && str(q.question).length > 0)
          .map((q) => ({
            question: str(q.question),
            header: str(q.header),
            multi: q.multiSelect === true,
            options: list(q.options)
              .map(obj)
              .filter((o): o is Record<string, unknown> => o !== null && str(o.label).length > 0)
              .map((o) => ({ label: str(o.label), description: str(o.description) })),
          }));
        if (questions.length === 0) throw new Error("it needs at least one question");
        return answered(await api.conversation.ask({ category: "question", name: named("question"), questions }));
      },
    });

    api.tools.add({
      name: named("plan"),
      category: "plan",
      except: ["claude"],
      description:
        "Present your plan to the user for approval and wait for the answer. Use it in plan mode once the plan is complete, instead of making changes. The answer says whether the user approved it (plan mode then ends and you carry it out) or what they want changed.",
      input: PLAN,
      call: async (args) => {
        const plan = str(args.plan).trim();
        if (plan.length === 0) throw new Error("it needs the plan");
        const reply = await api.conversation.ask({ category: "plan", name: named("plan"), plan });
        if (reply.state === "cancelled") return "The plan was withdrawn before the user answered.";
        if (reply.state !== "approved") return "The user did not approve the plan.\n\n" + reply.message;
        // In plan mode the agent cannot change anything until its next prompt, in the mode it leaves for.
        const next = api.agent.mode() === "plan" ? (api.agent.choices().modes.find((m) => m.value !== "plan")?.value ?? "") : "";
        if (next.length === 0 || api.agent.setMode(next).length > 0) return "The user approved the plan: carry it out.";
        api.agent.send("The plan is approved: carry it out.");
        return "The user approved the plan. Plan mode ends with this turn, and the next message asks you to carry the plan out: end this turn now, without making changes.";
      },
    });
  },
});

export {};
