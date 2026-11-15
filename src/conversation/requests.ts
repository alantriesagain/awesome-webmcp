// What a request asks the user and what they reply, whichever agent asks: questions with their
// choices (one or several), or a plan to approve; the user's answers, an approval, or why they
// declined. An agent's plugin reads its request into these and writes the reply as its agent
// expects it; one of widecode's own tools (an Ask) gets the reply as JSON.

export class Choice {
  label: string;
  description: string;

  constructor(label: string, description: string) {
    this.label = label;
    this.description = description;
  }
}

export class Question {
  question = "";
  header = "";
  multi = false;
  options: Choice[] = [];
}

/** The user's answer to one question: chosen labels, or their own words. */
export class Answer {
  question: string;
  labels: string[] = [];
  text = "";
  multi: boolean;

  constructor(question: string, multi: boolean) {
    this.question = question;
    this.multi = multi;
  }
}

/** The user's reply: "answered" (with answers), "approved" (a plan), "declined" (with why), or "cancelled" (the request went away before an answer). */
export class Reply {
  state: string;
  answers: Answer[] = [];
  message = "";

  constructor(state: string) {
    this.state = state;
  }
}

/** The reply as JSON text, as plugins get it: { state, answers: [{ question, labels, text }], message }. */
export const replyText = (reply: Reply): string => {
  const answers: string[] = [];
  for (const a of reply.answers) {
    const labels: string[] = [];
    for (const l of a.labels) labels.push(JSON.stringify(l));
    answers.push('{"question":' + JSON.stringify(a.question) + ',"labels":[' + labels.join(",") + '],"text":' + JSON.stringify(a.text) + "}");
  }
  return '{"state":' + JSON.stringify(reply.state) + ',"answers":[' + answers.join(",") + '],"message":' + JSON.stringify(reply.message) + "}";
};

/** A request one of widecode's own tools put to the user: the reply (replyText) goes to `onReplied`, not to the agent. */
export class Ask {
  onReplied: ((reply: string) => void) | null = null;
}
