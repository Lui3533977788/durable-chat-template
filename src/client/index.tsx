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
	const messagesRef = useRef<HTMLDivElement>(null);
	const nearBottomRef = useRef(true);

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
	}, [room]);

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
			});
		};
		reader.readAsDataURL(file);
	};

	const socket = usePartySocket({
		party: "chat",
		room,
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "add") {
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
								}
							: m,
					),
				);
			} else {
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
						className={`message ${message.user === name ? "self" : ""}`}
					>
						<div className="user">{message.user}</div>
						<div className="bubble">
							{message.media ? (
								message.media.startsWith("data:image/") ? (
									<img
										src={message.media}
										alt="Image"
										className="message-media"
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
			<form
				className="chat-input"
				onSubmit={(e) => {
					e.preventDefault();
					const content = e.currentTarget.elements.namedItem(
						"content",
					) as HTMLInputElement;
					if (!content.value.trim()) return;
					sendMessage({
						id: nanoid(8),
						content: content.value,
						user: name,
						role: "user",
					});
					content.value = "";
				}}
			>
				<label className="media-button" title="Attach image or video">
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
					Media
				</label>
				<input
					type="text"
					name="content"
					placeholder={`Message ${name}...`}
					autoComplete="off"
				/>
				<button type="submit">Send</button>
			</form>
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