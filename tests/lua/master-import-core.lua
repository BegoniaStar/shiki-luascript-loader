-- SPDX-License-Identifier: AGPL-3.0-only
-- Original small-script fixture: a dice master imports this through .luaplug.

msg_order = {}

local function caller(msg)
    return msg.uid .. "@" .. msg.gid
end

function watch_help(msg)
    return "watch-help:" .. caller(msg)
end

function watch_roll(msg)
    local count, difficulty, topic = msg.fromMsg:match("^%.smroll%s+(%d+)%s+(%d+)%s*(.-)%s*$")
    count = tonumber(count)
    difficulty = tonumber(difficulty)
    if not count or not difficulty then return "usage:.smroll <count> <difficulty> [topic]" end
    if count < 1 or count > 6 then return "count-out-of-range" end
    if difficulty < 2 or difficulty > 10 then return "difficulty-out-of-range" end

    local rolls, hits = {}, 0
    for i = 1, count do
        local face = ranint(1, 10)
        rolls[i] = face
        if face >= difficulty then hits = hits + 1 end
    end
    return "rolls=" .. table.concat(rolls, ",") .. ";hits=" .. hits .. ";topic=" .. topic
end

msg_order[".smhelp"] = "watch_help"
msg_order[".smroll"] = "watch_roll"

msg_order[".smstate"] = function(msg)
    local session = getSelfData("master-session")
    session.count = (session.count or 0) + 1
    setGroupConf(msg.gid, "watch-count", session.count)
    setUserConf(msg.uid, "watch-name", msg.nick)
    setUserToday(msg.uid, "watch-today", (getUserToday(msg.uid, "watch-today", 0) or 0) + 1)
    return "state=" .. session.count .. ";group=" .. getGroupConf(msg.gid, "watch-count", 0)
        .. ";user=" .. getUserConf(msg.uid, "watch-name", "")
        .. ";today=" .. getUserToday(msg.uid, "watch-today", 0)
end

msg_order[".smactor"] = function(msg)
    local card = getPlayerCard(msg.uid, msg.gid)
    card.rank = (card.rank or 0) + 1
    card:lock("rank")
    return "rank=" .. card:get("rank", 0) .. ";locked=" .. tostring(card:locked("rank"))
end

msg_order[".smlimit"] = {
    limit = { user_id = { "6401" }, grp_id = { "9001" }, prob = 90 },
    echo = "limited-command",
}
