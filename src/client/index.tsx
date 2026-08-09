import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useEffect, useRef, useState } from "react";
import {
	BrowserRouter,
	Routes,
	Route,
	Navigate,
	Link,
	useNavigate,
	useParams,
} from "react-router";
import { nanoid } from "nanoid";

import {
	normalizeRoomName,
	type AccountInfo,
	type AccountMessage,
	type ChatMessage,
	type Message,
	type RoomsMessage,
} from "../shared";

const SESSION_KEY = "durable-chat-session";
const THEME_KEY = "durable-chat-theme";
const NOTIFS_KEY = "durable-chat-notifs";
const OLD_USERNAME_KEY = "durable-chat-username";

type Session = {
	id: string;
	name: string;
	token: string;
	isOwner: boolean;
	uploadsDisabled: boolean;
	ownerConfigured: boolean;
};

function loadSession(): Session | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<Session>;
		if (!parsed.token) return null;
		return {
			id: parsed.id ?? "",
			name: parsed.name ?? "",
			token: parsed.token,
			isOwner: parsed.isOwner ?? false,
			uploadsDisabled: parsed.uploadsDisabled ?? false,
			ownerConfigured: parsed.ownerConfigured ?? false,
		};
	} catch (e) {
		return null;
	}
}

function formatTime(ts: number): string {
	const date = new Date(ts);
	const time = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const sameDay = date.toDateString() === new Date().toDateString();
	if (sameDay) return time;
	return `${date.toLocaleDateString([], {
		month: "short",
		day: "numeric",
	})}, ${time}`;
}

function notify(title: string, body: string) {
	if (!("Notification" in window) || Notification.permission !== "granted") {
		return;
	}
	try {
		new Notification(title, { body: body.slice(0, 200) });
	} catch (e) {
		// some browsers restrict the Notification constructor
	}
}

function replyPreview(m: ChatMessage): string {
	if (m.media) {
		return m.media.startsWith("data:image/") ? "[Image]" : "[Video]";
	}
	const text = m.content.trim();
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function isSelf(
	message: { userId?: string; user: string },
	account: AccountInfo,
): boolean {
	return message.userId === account.id || message.user === account.name;
}

function ChatRoom({
	room,
	account,
	token,
	notifsPref,
	isOwner,
	uploadsDisabled,
	restrictedUsers,
	onRuleResult,
	onOpenSidebar,
}: {
	room: string;
	account: AccountInfo;
	token: string;
	notifsPref: boolean;
	isOwner: boolean;
	uploadsDisabled: boolean;
	restrictedUsers: { id: string; name: string }[];
	onRuleResult: (
		ok: boolean,
		message: string,
		targetId: string,
	) => void;
	onOpenSidebar: () => void;
}) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
	const [draft, setDraft] = useState("");
	const [typingUsers, setTypingUsers] = useState<string[]>([]);
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const messagesRef = useRef<HTMLDivElement>(null);
	const nearBottomRef = useRef(true);
	const lastTypingSentRef = useRef(0);

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(null), 3000);
		return () => clearTimeout(t);
	}, [toast]);

	useEffect(() => {
		// keep scrolled to the latest message unless the user scrolled up
		const el = messagesRef.current;
		if (el && nearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages]);

	useEffect(() => {
		// always jump to the latest message when switching rooms
		const el = messagesRef.current;
		if (el) {
			nearBottomRef.current = true;
			el.scrollTop = el.scrollHeight;
		}
		// reset per-room state
		setTypingUsers([]);
		setReplyTo(null);
		setDraft("");
	}, [room]);

	useEffect(() => {
		// safety net: hide the indicator if no updates arrive
		if (typingUsers.length === 0) return;
		const t = setTimeout(() => setTypingUsers([]), 5000);
		return () => clearTimeout(t);
	}, [typingUsers]);

	const sendTyping = (stop: boolean) => {
		if (stop) {
			lastTypingSentRef.current = 0;
			socket.send(
				JSON.stringify({
					type: "typing-stop",
					user: account.name,
				} satisfies Message),
			);
			return;
		}
		// throttle: at most one typing ping every 2.5s
		const now = Date.now();
		if (now - lastTypingSentRef.current < 2500) return;
		lastTypingSentRef.current = now;
		socket.send(
			JSON.stringify({
				type: "typing-start",
				user: account.name,
			} satisfies Message),
		);
	};

	const jumpTo = (id: string) => {
		const el = document.querySelector<HTMLElement>(`[data-mid="${id}"]`);
		if (!el) return;
		el.scrollIntoView({ block: "center", behavior: "smooth" });
		setHighlightId(id);
		setTimeout(() => setHighlightId(null), 2000);
	};

	const sendMessage = (chatMessage: ChatMessage) => {
		setMessages((messages) => [...messages, chatMessage]);
		socket.send(
			JSON.stringify({
				type: "add",
				...chatMessage,
			} satisfies Message),
		);
	};

	const toggleUploads = (message: ChatMessage) => {
		if (!message.userId) return;
		const disabled = !restrictedUsers.some((r) => r.id === message.userId);
		socket.send(
			JSON.stringify({
				type: "uploads-rule",
				token,
				targetId: message.userId,
				disabled,
			} satisfies Message),
		);
	};

	const handleFile = (file: File) => {
		const isImage = file.type.startsWith("image/");
		const isVideo = file.type.startsWith("video/");
		if (!isImage && !isVideo) return;
		const maxSize = isImage ? 3 * 1024 * 1024 : 8 * 1024 * 1024;
		if (file.size > maxSize) {
			window.alert(
				`File too large. Max ${isImage ? "3" : "8"} MB (Cloudflare limit).`,
			);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const media = reader.result as string;
			sendMessage({
				id: nanoid(8),
				content: "",
				user: account.name,
				userId: account.id,
				role: "user",
				media,
				timestamp: Date.now(),
			});
		};
		reader.readAsDataURL(file);
	};

	const [lightbox, setLightbox] = useState<string | null>(null);

	useEffect(() => {
		if (!lightbox) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setLightbox(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lightbox]);

	const socket = usePartySocket({
		party: "chat",
		room,
		query: { token },
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "typing") {
				setTypingUsers(message.users.filter((u) => u !== account.name));
				return;
			}
			if (message.type === "uploads-rule-result") {
				setToast(
					message.ok
						? message.message
						: `Couldn't change upload permission: ${message.message}`,
				);
				onRuleResult(message.ok, message.message, message.targetId);
				return;
			}
			if (message.type === "uploads-disabled") {
				setToast(
					"Uploads are disabled for your account. You can still send text messages.",
				);
				return;
			}
			if (message.type === "add") {
				if (
					!isSelf(message, account) &&
					document.hidden &&
					notifsPref
				) {
					notify(
						`#${room}: ${message.user}`,
						message.media
							? message.media.startsWith("data:image/")
								? "Sent an image"
								: "Sent a video"
							: message.content,
					);
				}
				const foundIndex = messages.findIndex((m) => m.id === message.id);
				if (foundIndex === -1) {
					setMessages((messages) => [
						...messages,
						{
							id: message.id,
							content: message.content,
							user: message.user,
							userId: message.userId,
							role: message.role,
							media: message.media,
							timestamp: message.timestamp,
							replyTo: message.replyTo,
						},
					]);
				} else {
					setMessages((messages) => {
						return messages
							.slice(0, foundIndex)
							.concat({
								id: message.id,
								content: message.content,
								user: message.user,
								userId: message.userId,
								role: message.role,
								media: message.media,
								timestamp: message.timestamp,
								replyTo: message.replyTo,
							})
							.concat(messages.slice(foundIndex + 1));
					});
				}
			} else if (message.type === "update") {
				setMessages((messages) =>
					messages.map((m) =>
						m.id === message.id
							? {
									id: message.id,
									content: message.content,
									user: message.user,
									userId: message.userId,
									role: message.role,
									media: message.media,
									timestamp: message.timestamp,
									replyTo: message.replyTo,
								}
							: m,
					),
				);
			} else if (message.type === "all") {
				setMessages(message.messages);
			}
		},
	});

	return (
		<div className="chat">
			<div className="chat-header">
				<button
					type="button"
					className="menu-button"
					onClick={onOpenSidebar}
					aria-label="Open rooms"
				>
					☰
				</button>
				<span>
					<b>#{room}</b>
				</span>
			</div>
			<div
				className="messages"
				ref={messagesRef}
				onScroll={(e) => {
					const el = e.currentTarget;
					nearBottomRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 100;
				}}
			>
				{messages.map((message) => (
					<div
						key={message.id}
						data-mid={message.id}
						className={`message ${
							isSelf(message, account) ? "self" : ""
						} ${message.id === highlightId ? "highlighted" : ""}`}
					>
						<div className="user">
							{message.user}
							{message.timestamp && (
								<span className="time">
									{formatTime(message.timestamp)}
								</span>
							)}
							<button
								type="button"
								className="reply-button"
								title="Reply"
								onClick={() => {
									setReplyTo(message);
									setDraft("");
								}}
							>
								↩
							</button>
							{isOwner && message.userId && !isSelf(message, account) && (
								<button
									type="button"
									className="uploads-button"
									title={
										restrictedUsers.some(
											(r) => r.id === message.userId,
										)
											? "Allow uploads"
											: "Block uploads"
									}
									onClick={() => toggleUploads(message)}
								>
									🚫
								</button>
							)}
						</div>
						<div className="bubble">
							{message.replyTo && (
								<button
									type="button"
									className="reply-quote"
									onClick={() => jumpTo(message.replyTo!.id)}
								>
									<span className="reply-quote-user">
										↩ {message.replyTo.user}
									</span>
									<span className="reply-quote-content">
										{message.replyTo.content}
									</span>
								</button>
							)}
							{message.media ? (
								message.media.startsWith("data:image/") ? (
									<img
										src={message.media}
										alt="Image"
										className="message-media"
										onClick={() =>
											setLightbox(message.media as string)
										}
									/>
								) : (
									<video
										src={message.media}
										controls
										className="message-media"
									/>
								)
							) : (
								message.content
							)}
						</div>
					</div>
				))}
			</div>
			{lightbox && (
				<div className="lightbox" onClick={() => setLightbox(null)}>
					<img src={lightbox} alt="Enlarged image" />
					<button
						type="button"
						className="lightbox-close"
						onClick={() => setLightbox(null)}
						aria-label="Close image"
					>
						×
					</button>
				</div>
			)}
			{toast && <div className="chat-toast">{toast}</div>}
			<div className="composer">
				{typingUsers.length > 0 && (
					<div className="typing-row">
						<span className="typing-dots">
							<span />
							<span />
							<span />
						</span>
						{typingUsers.length === 1
							? `${typingUsers[0]} is typing…`
							: `${typingUsers
									.slice(0, 2)
									.join(", ")}${typingUsers.length > 2 ? " and others" : ""} are typing…`}
					</div>
				)}
				{replyTo && (
					<div className="reply-bar">
						<span className="reply-bar-label">
							Replying to <b>{replyTo.user}</b>: {replyPreview(replyTo)}
						</span>
						<button
							type="button"
							className="reply-bar-close"
							onClick={() => setReplyTo(null)}
							aria-label="Cancel reply"
						>
							×
						</button>
					</div>
				)}
				<form
					className="chat-input"
					onSubmit={(e) => {
						e.preventDefault();
						if (!draft.trim()) return;
						sendMessage({
							id: nanoid(8),
							content: draft,
							user: account.name,
							userId: account.id,
							role: "user",
							timestamp: Date.now(),
							replyTo: replyTo
								? {
										id: replyTo.id,
										user: replyTo.user,
										content: replyPreview(replyTo),
									}
								: undefined,
						});
						setDraft("");
						setReplyTo(null);
						sendTyping(true);
					}}
				>
					{uploadsDisabled ? (
						<span
							className="media-button disabled"
							title="Uploads are disabled for your account"
							aria-label="Uploads are disabled"
						>
							<input
								type="file"
								accept="image/*,video/*"
								disabled
								hidden
							/>
						</span>
					) : (
						<label
							className="media-button"
							title="Attach image or video"
							aria-label="Attach image or video"
						>
							<input
								type="file"
								accept="image/*,video/*"
								onChange={(e) => {
									const file = e.currentTarget.files?.[0];
									if (file) handleFile(file);
									e.currentTarget.value = "";
								}}
								hidden
							/>
						</label>
					)}
					<input
						type="text"
						name="content"
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							if (e.target.value.trim()) {
								sendTyping(false);
							} else {
								sendTyping(true);
							}
						}}
						placeholder={`Message ${account.name}...`}
						autoComplete="off"
					/>
					<button type="submit">Send</button>
				</form>
			</div>
		</div>
	);
}

function Sidebar({
	name,
	rooms,
	activeRoom,
	open,
	onClose,
	onCreateRoom,
	onRename,
	onDelete,
	onOpenSettings,
}: {
	name: string;
	rooms: string[];
	activeRoom?: string;
	open: boolean;
	onClose: () => void;
	onCreateRoom: (name: string) => void;
	onRename: (oldName: string, newName: string) => void;
	onDelete: (name: string) => void;
	onOpenSettings: () => void;
}) {
	const [newRoom, setNewRoom] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const submitRename = (oldName: string) => {
		const normalized = normalizeRoomName(renameValue);
		setRenaming(null);
		if (!normalized || normalized === oldName) return;
		onRename(oldName, normalized);
	};

	return (
		<>
			<div
				className={`sidebar-backdrop ${open ? "open" : ""}`}
				onClick={onClose}
			/>
			<aside className={`sidebar ${open ? "open" : ""}`}>
				<div className="sidebar-header">
					Chat
					<button
						type="button"
						className="sidebar-close"
						onClick={onClose}
						aria-label="Close rooms"
					>
						×
					</button>
				</div>
				<div className="sidebar-section">ROOMS</div>
			<ul className="room-list">
				{rooms.map((room) =>
					renaming === room ? (
						<li key={room} className="room-item">
							<form
								className="room-rename"
								onSubmit={(e) => {
									e.preventDefault();
									submitRename(room);
								}}
							>
								<input
									type="text"
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape") setRenaming(null);
									}}
									autoFocus
									maxLength={24}
								/>
							</form>
						</li>
					) : (
						<li key={room} className="room-item">
							<Link
								to={`/${room}`}
								className={`room-link ${room === activeRoom ? "active" : ""}`}
							>
								# {room}
							</Link>
							<div className="room-actions">
								<button
									type="button"
									onClick={() => {
										setRenaming(room);
										setRenameValue(room);
									}}
								>
									rename
								</button>
								<button
									type="button"
									onClick={() => {
										if (window.confirm(`Delete room #${room}?`)) {
											onDelete(room);
										}
									}}
								>
									delete
								</button>
							</div>
						</li>
					),
				)}
			</ul>
			<form
				className="new-room"
				onSubmit={(e) => {
					e.preventDefault();
					if (newRoom.trim()) {
						onCreateRoom(newRoom.trim());
						setNewRoom("");
					}
				}}
			>
				<input
					type="text"
					value={newRoom}
					onChange={(e) => setNewRoom(e.target.value)}
					placeholder="New room..."
					autoComplete="off"
					maxLength={24}
				/>
				<button type="submit" aria-label="Create room">
					+
				</button>
			</form>
			<div className="sidebar-footer">
				<span title={name}>{name}</span>
				<button
					type="button"
					className="sidebar-settings"
					onClick={onOpenSettings}
					aria-label="Open settings"
					title="Settings"
				>
					⚙
				</button>
			</div>
			</aside>
		</>
	);
}

function AccountsGate({
	onMessage,
	children,
}: {
	onMessage: (m: AccountMessage) => void;
	children: (send: (msg: AccountMessage) => void) => React.ReactNode;
}) {
	const socket = usePartySocket({
		party: "accounts",
		room: "registry",
		onMessage: (evt) => {
			onMessage(JSON.parse(evt.data as string) as AccountMessage);
		},
	});
	return <>{children((msg) => socket.send(JSON.stringify(msg)))}</>;
}

function Welcome({
	initialName,
	error,
	onAuth,
}: {
	initialName: string;
	error: string | null;
	onAuth: (msg: AccountMessage) => void;
}) {
	const [mode, setMode] = useState<"login" | "signup">("signup");
	const [name, setName] = useState(initialName);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [remember, setRemember] = useState(true);
	const [localError, setLocalError] = useState<string | null>(null);

	const errorMsg = localError ?? error;

	const submit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setLocalError("Pick a name.");
			return;
		}
		if (mode === "signup" && password.length < 6) {
			setLocalError("Password must be at least 6 characters.");
			return;
		}
		if (mode === "signup" && password !== confirm) {
			setLocalError("Passwords don't match.");
			return;
		}
		setLocalError(null);
		onAuth(
			mode === "signup"
				? { type: "register", name: trimmed, password, remember }
				: { type: "login", name: trimmed, password, remember },
		);
	};

	return (
		<div className="chat">
			<div className="welcome">
				<h2>Chat</h2>
				<p>
					Pick a name and a password so nobody can chat as you.
				</p>
				<div className="auth-tabs">
					<button
						type="button"
						className={mode === "signup" ? "active" : ""}
						onClick={() => {
							setMode("signup");
							setLocalError(null);
						}}
					>
						Create account
					</button>
					<button
						type="button"
						className={mode === "login" ? "active" : ""}
						onClick={() => {
							setMode("login");
							setLocalError(null);
						}}
					>
						Log in
					</button>
				</div>
				<form className="auth-form" onSubmit={submit}>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Name"
						maxLength={24}
						autoComplete="username"
					/>
					<input
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="Password"
						autoComplete={
							mode === "signup" ? "new-password" : "current-password"
						}
					/>
					{mode === "signup" && (
						<input
							type="password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							placeholder="Repeat password"
							autoComplete="new-password"
						/>
					)}
					<label className="auth-remember">
						<input
							type="checkbox"
							checked={remember}
							onChange={(e) => setRemember(e.target.checked)}
						/>
						Keep me signed in on this browser
					</label>
					{errorMsg && <p className="auth-error">{errorMsg}</p>}
					<button type="submit">
						{mode === "signup" ? "Create account" : "Log in"}
					</button>
				</form>
			</div>
		</div>
	);
}

function SettingsModal({
	account,
	token,
	notifsPref,
	onToggleNotifs,
	theme,
	onSetTheme,
	notice,
	onClearNotice,
	onClose,
	onSignOut,
	isOwner,
	ownerConfigured,
	restrictedUsers,
	onToggleUploads,
	send,
}: {
	account: AccountInfo;
	token: string;
	notifsPref: boolean;
	onToggleNotifs: (value: boolean) => void;
	theme: "dark" | "light";
	onSetTheme: (theme: "dark" | "light") => void;
	notice: { ok: boolean; text: string } | null;
	onClearNotice: () => void;
	onClose: () => void;
	onSignOut: () => void;
	isOwner: boolean;
	ownerConfigured: boolean;
	restrictedUsers: { id: string; name: string }[];
	onToggleUploads: (targetId: string, disabled: boolean) => void;
	send: (msg: AccountMessage) => void;
}) {
	const [nameInput, setNameInput] = useState(account.name);
	const [notifHint, setNotifHint] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!notice) return;
		const t = setTimeout(onClearNotice, 2500);
		return () => clearTimeout(t);
	}, [notice, onClearNotice]);

	useEffect(() => {
		if (isOwner) {
			send({ type: "uploads-restricted-list", token });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const copyAccountId = async () => {
		try {
			await navigator.clipboard.writeText(account.id);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (e) {
			// clipboard unavailable; the id is visible so it can be copied by hand
		}
	};

	const saveName = () => {
		const newName = nameInput.trim();
		if (!newName || newName === account.name) return;
		send({ type: "rename", token, newName });
	};

	const toggleNotifs = async () => {
		setNotifHint(null);
		if (notifsPref) {
			onToggleNotifs(false);
			return;
		}
		if (!("Notification" in window)) {
			setNotifHint("This browser doesn't support notifications.");
			return;
		}
		const result = await Notification.requestPermission();
		if (result === "granted") {
			onToggleNotifs(true);
		} else if (result === "denied") {
			setNotifHint(
				"Blocked by the browser. Allow notifications for this site in your browser settings.",
			);
		} else {
			setNotifHint("Notifications not enabled.");
		}
	};

	const signOut = () => {
		send({ type: "logout", token });
		onSignOut();
	};

	return (
		<div className="settings-overlay" onClick={onClose}>
			<div
				className="settings-modal"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="settings-header">
					Settings
					<button
						type="button"
						className="settings-close"
						onClick={onClose}
						aria-label="Close settings"
					>
						×
					</button>
				</div>
				<div className="settings-body">
					<div className="settings-section">ACCOUNT</div>
					<div className="settings-row">
						<span className="settings-label">Signed in as</span>
						<span className="settings-value">{account.name}</span>
					</div>
					{isOwner && (
						<div className="settings-row">
							<span className="settings-label">Role</span>
							<span className="settings-value">You are the site owner</span>
						</div>
					)}
					{!ownerConfigured && (
						<>
							<div className="settings-row">
								<span className="settings-label">
									Your account ID
								</span>
								<span className="settings-value">
									<code className="account-id">{account.id}</code>
								</span>
							</div>
							<div className="settings-row">
								<button
									type="button"
									className="settings-copy"
									onClick={copyAccountId}
								>
									{copied ? "Copied!" : "Copy account ID"}
								</button>
							</div>
							<p className="settings-hint">
								No site owner is configured yet. Copy your account
								ID, then run{" "}
								<code>npx wrangler secret put OWNER_ACCOUNT_IDS</code>{" "}
								and paste it. After redeploying, this line
								disappears for everyone.
							</p>
						</>
					)}
					<form
						className="settings-rename"
						onSubmit={(e) => {
							e.preventDefault();
							saveName();
						}}
					>
						<input
							type="text"
							value={nameInput}
							onChange={(e) => setNameInput(e.target.value)}
							placeholder="Account name"
							maxLength={24}
							autoComplete="off"
						/>
						<button type="submit">Save</button>
					</form>

					<div className="settings-section">NOTIFICATIONS</div>
					<div className="settings-row">
						<span className="settings-label">
							New message notifications
						</span>
						<button
							type="button"
							role="switch"
							aria-checked={notifsPref}
							className={`switch ${notifsPref ? "on" : ""}`}
							onClick={toggleNotifs}
						>
							<span className="switch-knob" />
						</button>
					</div>
					{notifHint && <p className="settings-hint">{notifHint}</p>}

					<div className="settings-section">APPEARANCE</div>
					<div className="settings-row">
						<span className="settings-label">Theme</span>
						<div className="theme-toggle">
							<button
								type="button"
								className={theme === "dark" ? "active" : ""}
								onClick={() => onSetTheme("dark")}
							>
								Dark
							</button>
							<button
								type="button"
								className={theme === "light" ? "active" : ""}
								onClick={() => onSetTheme("light")}
							>
								Light
							</button>
						</div>
					</div>

					{isOwner && (
						<>
							<div className="settings-section">ADMIN</div>
							<p className="settings-hint">
								Users below can't send images or videos, but can
								still chat normally.
							</p>
							{restrictedUsers.length === 0 ? (
								<p className="settings-hint">
									Nobody is blocked right now. Block someone from
									a message in any room with the 🚫 button.
								</p>
							) : (
								<ul className="restricted-list">
									{restrictedUsers.map((user) => (
										<li key={user.id} className="restricted-item">
											<span>{user.name}</span>
											<button
												type="button"
												onClick={() =>
													onToggleUploads(user.id, false)
												}
											>
												Allow uploads
											</button>
										</li>
									))}
								</ul>
							)}
						</>
					)}

					{notice && (
						<p
							className={`settings-notice ${
								notice.ok ? "ok" : "error"
							}`}
						>
							{notice.text}
						</p>
					)}

					<div className="settings-section">SESSION</div>
					<button
						type="button"
						className="settings-signout"
						onClick={signOut}
					>
						Sign out
					</button>
					<p className="settings-hint">
						Signing out removes this browser from the account. You can
						log back in with your name and password.
					</p>
				</div>
			</div>
		</div>
	);
}

function App() {
	const [session, setSession] = useState<Session | null>(() => loadSession());
	const [rooms, setRooms] = useState<string[]>([]);
	const [roomsLoaded, setRoomsLoaded] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [authError, setAuthError] = useState<string | null>(null);
	const [accountNotice, setAccountNotice] = useState<{
		ok: boolean;
		text: string;
	} | null>(null);
	const [notifsPref, setNotifsPref] = useState(
		() => localStorage.getItem(NOTIFS_KEY) === "on",
	);
	const [restrictedUsers, setRestrictedUsers] = useState<
		{ id: string; name: string }[]
	>([]);
	const [theme, setTheme] = useState<"dark" | "light">(() =>
		localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark",
	);
	const { room } = useParams();
	const navigate = useNavigate();

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem(THEME_KEY, theme);
	}, [theme]);

	const account = session
		? {
				id: session.id,
				name: session.name,
				isOwner: session.isOwner,
				uploadsDisabled: session.uploadsDisabled,
			}
		: null;
	const token = session?.token ?? null;

	const roomsSocket = usePartySocket({
		party: "rooms",
		room: "registry",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as RoomsMessage;
			if (message.type === "rooms") {
				setRooms(message.rooms);
				setRoomsLoaded(true);
			}
		},
	});

	useEffect(() => {
		// if the room we're in got deleted, send us home
		if (roomsLoaded && room && !rooms.includes(room)) {
			navigate("/");
		}
	}, [roomsLoaded, room, rooms, navigate]);

	useEffect(() => {
		// close the mobile sidebar whenever we navigate to a room
		setSidebarOpen(false);
	}, [room]);

	const handleAccountMessage = (m: AccountMessage) => {
		if (m.type === "registered" || m.type === "logged-in") {
			const sessionData = {
				id: m.id,
				name: m.name,
				token: m.token,
				isOwner: m.isOwner,
				uploadsDisabled: m.uploadsDisabled,
				ownerConfigured: m.ownerConfigured,
			};
			if (m.remember) {
				localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
			}
			setSession(sessionData);
			setAuthError(null);
			setAccountNotice(null);
		} else if (m.type === "uploads-restricted") {
			setRestrictedUsers(m.accounts);
		} else if (m.type === "uploads-rule-done") {
			if (m.ok) {
				setRestrictedUsers((prev) =>
					prev.some((r) => r.id === m.targetId)
						? prev.filter((r) => r.id !== m.targetId)
						: [...prev, { id: m.targetId, name: "?" }],
				);
			}
			setAccountNotice({ ok: m.ok, text: m.message });
		} else if (m.type === "renamed") {
			setSession((prev) => {
				const next = prev ? { ...prev, name: m.name } : prev;
				if (next && localStorage.getItem(SESSION_KEY)) {
					localStorage.setItem(SESSION_KEY, JSON.stringify(next));
				}
				return next;
			});
			setAccountNotice({ ok: true, text: `Name changed to "${m.name}".` });
		} else if (m.type === "error") {
			if (m.code === "session") {
				localStorage.removeItem(SESSION_KEY);
				setSession(null);
				setSettingsOpen(false);
				setRestrictedUsers([]);
				setAuthError("Your session expired. Sign in again.");
			} else if (account) {
				setAccountNotice({ ok: false, text: m.message });
			} else {
				setAuthError(m.message);
			}
		}
	};

	const handleRuleResult = (
		ok: boolean,
		_message: string,
		targetId: string,
	) => {
		if (!ok) return;
		setRestrictedUsers((prev) =>
			prev.some((r) => r.id === targetId)
				? prev.filter((r) => r.id !== targetId)
				: [...prev, { id: targetId, name: "?" }],
		);
	};

	const setNotifs = (value: boolean) => {
		setNotifsPref(value);
		localStorage.setItem(NOTIFS_KEY, value ? "on" : "off");
	};

	if (!account || !token) {
		return (
			<AccountsGate onMessage={handleAccountMessage}>
				{(send) => (
					<Welcome
						initialName={localStorage.getItem(OLD_USERNAME_KEY) ?? ""}
						error={authError}
						onAuth={(msg) => send(msg)}
					/>
				)}
			</AccountsGate>
		);
	}

	return (
		<div className="app-layout">
			<Sidebar
				name={account.name}
				rooms={rooms}
				activeRoom={room}
				open={sidebarOpen}
				onClose={() => setSidebarOpen(false)}
				onCreateRoom={(value) => {
					const normalized = normalizeRoomName(value);
					if (!normalized) return;
					roomsSocket.send(
						JSON.stringify({
							type: "create",
							name: normalized,
						} satisfies RoomsMessage),
					);
					navigate(`/${normalized}`);
				}}
				onRename={(oldName, newName) => {
					roomsSocket.send(
						JSON.stringify({
							type: "rename",
							oldName,
							newName,
						} satisfies RoomsMessage),
					);
					if (room === oldName) {
						navigate(`/${newName}`);
					}
				}}
				onDelete={(name) => {
					roomsSocket.send(
						JSON.stringify({
							type: "delete",
							name,
						} satisfies RoomsMessage),
					);
					if (room === name) {
						navigate("/");
					}
				}}
				onOpenSettings={() => {
					setAccountNotice(null);
					setSettingsOpen(true);
				}}
			/>
			{room ? (
				<ChatRoom
					key={`${room}:${account.name}`}
					room={room}
					account={account}
					token={token}
					notifsPref={notifsPref}
					isOwner={account.isOwner}
					uploadsDisabled={account.uploadsDisabled}
					restrictedUsers={restrictedUsers}
					onRuleResult={handleRuleResult}
					onOpenSidebar={() => setSidebarOpen(true)}
				/>
			) : (
				<div className="empty-state">
					<h3>Welcome to Chat</h3>
					<p>Pick a room, or create a new one to start chatting.</p>
					<button
						type="button"
						className="empty-state-button"
						onClick={() => setSidebarOpen(true)}
					>
						Browse rooms
					</button>
				</div>
			)}
			{settingsOpen && (
				<AccountsGate onMessage={handleAccountMessage}>
					{(send) => (
						<SettingsModal
							account={account}
							token={token}
							notifsPref={notifsPref}
							onToggleNotifs={setNotifs}
							theme={theme}
							onSetTheme={setTheme}
							notice={accountNotice}
							onClearNotice={() => setAccountNotice(null)}
							onClose={() => setSettingsOpen(false)}
							onSignOut={() => {
								localStorage.removeItem(SESSION_KEY);
								setSession(null);
								setSettingsOpen(false);
								setRestrictedUsers([]);
								setAuthError(null);
								navigate("/");
							}}
							isOwner={account.isOwner}
							ownerConfigured={session?.ownerConfigured ?? false}
							restrictedUsers={restrictedUsers}
							onToggleUploads={(targetId, disabled) => {
								send({
									type: "uploads-rule",
									token,
									targetId,
									disabled,
								});
							}}
							send={send}
						/>
					)}
				</AccountsGate>
			)}
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
		<Routes>
			<Route path="/" element={<App />} />
			<Route path="/:room" element={<App />} />
			<Route path="*" element={<Navigate to="/" />} />
		</Routes>
	</BrowserRouter>,
);
