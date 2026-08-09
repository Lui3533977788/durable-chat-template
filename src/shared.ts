export type ReplyTo = {
	id: string;
	user: string;
	content: string;
};

export type ChatMessage = {
	id: string;
	content: string;
	user: string;
	userId?: string;
	role: "user" | "assistant";
	media?: string;
	timestamp?: number;
	replyTo?: ReplyTo;
};

export type Message =
	| {
			type: "add";
			id: string;
			content: string;
			user: string;
			userId?: string;
			role: "user" | "assistant";
			media?: string;
			timestamp?: number;
			replyTo?: ReplyTo;
	  }
	| {
			type: "update";
			id: string;
			content: string;
			user: string;
			userId?: string;
			role: "user" | "assistant";
			media?: string;
			timestamp?: number;
			replyTo?: ReplyTo;
	  }
	| {
			type: "all";
			messages: ChatMessage[];
	  }
	| {
			type: "typing";
			users: string[];
	  }
	| {
			type: "typing-start";
			user: string;
	  }
	| {
			type: "typing-stop";
			user: string;
	  }
	| {
			type: "uploads-rule";
			token: string;
			targetId: string;
			disabled: boolean;
	  }
	| {
			type: "uploads-rule-result";
			ok: boolean;
			message: string;
			targetId: string;
	  }
	| {
			type: "uploads-disabled";
	  };

export type AccountInfo = {
	id: string;
	name: string;
	isOwner: boolean;
	uploadsDisabled: boolean;
};

export type AccountMessage =
	| {
			type: "register";
			name: string;
			password: string;
			remember: boolean;
	  }
	| {
			type: "login";
			name: string;
			password: string;
			remember: boolean;
	  }
	| {
			type: "registered";
			id: string;
			name: string;
			token: string;
			remember: boolean;
			isOwner: boolean;
			uploadsDisabled: boolean;
			ownerConfigured: boolean;
	  }
	| {
			type: "logged-in";
			id: string;
			name: string;
			token: string;
			remember: boolean;
			isOwner: boolean;
			uploadsDisabled: boolean;
			ownerConfigured: boolean;
	  }
	| {
			type: "rename";
			token: string;
			newName: string;
	  }
	| {
			type: "renamed";
			name: string;
	  }
	| {
			type: "logout";
			token: string;
	  }
	| {
			type: "uploads-rule";
			token: string;
			targetId: string;
			disabled: boolean;
	  }
	| {
			type: "uploads-rule-done";
			ok: boolean;
			message: string;
			targetId: string;
	  }
	| {
			type: "uploads-restricted-list";
			token: string;
	  }
	| {
			type: "uploads-restricted";
			accounts: AccountInfo[];
	  }
	| {
			type: "error";
			code: "name-taken" | "invalid" | "invalid-input" | "session" | "forbidden";
			message: string;
	  };

export type RoomsMessage =
	| {
			type: "rooms";
			rooms: string[];
	  }
	| {
			type: "create";
			name: string;
	  }
	| {
			type: "rename";
			oldName: string;
			newName: string;
	  }
	| {
			type: "delete";
			name: string;
	  };

export function normalizeRoomName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-_]/g, "")
		.slice(0, 24);
}

export const names = [
	"Alice",
	"Bob",
	"Charlie",
	"David",
	"Eve",
	"Frank",
	"Grace",
	"Heidi",
	"Ivan",
	"Judy",
	"Kevin",
	"Linda",
	"Mallory",
	"Nancy",
	"Oscar",
	"Peggy",
	"Quentin",
	"Randy",
	"Steve",
	"Trent",
	"Ursula",
	"Victor",
	"Walter",
	"Xavier",
	"Yvonne",
	"Zoe",
];