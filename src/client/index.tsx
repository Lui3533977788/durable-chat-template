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
	type ChatMessage,
	type Message,
	type RoomsMessage,
} from "../shared";

const USERNAME_KEY = "durable-chat-username";

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

function ChatRoom({
	room,
	name,
	onOpenSidebar,
}: {
	room: string;
	name: string;
	onOpenSidebar: () => void;
}) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
	const [draft, setDraft] = useState("");
	const [typingUsers, setTypingUsers] = useState<string[]>([]);
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const messagesRef = useRef<HTMLDivElement>(null);
	const nearBottomRef = useRef(true);
	const lastTypingSentRef = useRef(0);

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
					user: name,
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
				user: name,
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
				user: name,
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
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "typing") {
				setTypingUsers(message.users.filter((u) => u !== name));
				return;
			}
			if (message.type === "add") {
				if (message.user !== name && document.hidden) {
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
						className={`message ${message.user === name ? "self" : ""} ${
							message.id === highlightId ? "highlighted" : ""
						}`}
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
							user: name,
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
						placeholder={`Message ${name}...`}
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
	onChangeName,
}: {
	name: string;
	rooms: string[];
	activeRoom?: string;
	open: boolean;
	onClose: () => void;
	onCreateRoom: (name: string) => void;
	onRename: (oldName: string, newName: string) => void;
	onDelete: (name: string) => void;
	onChangeName: () => void;
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
			<NotificationsButton />
			<div className="sidebar-footer">
				<span title={name}>{name}</span>
				<button type="button" onClick={onChangeName}>
					Change name
				</button>
			</div>
			</aside>
		</>
	);
}

function NotificationsButton() {
	const [permission, setPermission] = useState<NotificationPermission>(() =>
		"Notification" in window ? Notification.permission : "denied",
	);

	if (!("Notification" in window)) {
		return (
			<button type="button" className="sidebar-notify" disabled>
				Notifications not supported
			</button>
		);
	}

	if (permission === "granted") {
		return (
			<button type="button" className="sidebar-notify on" disabled>
				Notifications on
			</button>
		);
	}

	return (
		<button
			type="button"
			className="sidebar-notify"
			onClick={async () => {
				const result = await Notification.requestPermission();
				setPermission(result);
			}}
		>
			{permission === "denied"
				? "Notifications blocked"
				: "Enable notifications"}
		</button>
	);
}

function App() {
	const [name, setName] = useState(
		() => localStorage.getItem(USERNAME_KEY) ?? "",
	);
	const [rooms, setRooms] = useState<string[]>([]);
	const [roomsLoaded, setRoomsLoaded] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const { room } = useParams();
	const navigate = useNavigate();

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

	if (!name) {
		return (
			<div className="chat">
				<div className="welcome">
					<h2>Chat</h2>
					<p>Pick a username to start chatting with your friends.</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const input = e.currentTarget.elements.namedItem(
								"username",
							) as HTMLInputElement;
							const username = input.value.trim();
							if (username) {
								localStorage.setItem(USERNAME_KEY, username);
								setName(username);
							}
						}}
					>
						<input
							type="text"
							name="username"
							placeholder="Enter your username..."
							autoComplete="off"
							maxLength={24}
						/>
						<button type="submit">Join</button>
					</form>
				</div>
			</div>
		);
	}

	return (
		<div className="app-layout">
			<Sidebar
				name={name}
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
				onChangeName={() => {
					localStorage.removeItem(USERNAME_KEY);
					setName("");
				}}
			/>
			{room ? (
				<ChatRoom
					room={room}
					name={name}
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