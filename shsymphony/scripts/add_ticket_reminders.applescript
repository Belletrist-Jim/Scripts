-- Adds 4 "余票处理" reminders (due 3 weeks before the concert) to the "长期" list in Reminders.app

on makeDateTime(y, mo, d, h, mi)
	set theDate to current date
	set day of theDate to 1
	set year of theDate to y
	set month of theDate to mo
	set day of theDate to d
	set hours of theDate to h
	set minutes of theDate to mi
	set seconds of theDate to 0
	return theDate
end makeDateTime

on addTicketReminder(theName, y, mo, d, h, mi)
	set dueDate to my makeDateTime(y, mo, d, h, mi)
	tell application "Reminders"
		tell list "长期"
			make new reminder with properties {name:theName, due date:dueDate, remind me date:dueDate}
		end tell
	end tell
end addTicketReminder

my addTicketReminder("余票处理：上海交响乐团2026-27音乐季开幕音乐会（二）肖斯塔科维奇第十交响曲-2026-09-13-共2张", 2026, 8, 23, 19, 30)

my addTicketReminder("余票处理：孙一凡、上海交响乐团与国家大剧院合唱团演绎《布兰诗歌》-2026-09-25-共3张", 2026, 9, 4, 19, 30)

my addTicketReminder("余票处理：水蓝、卡瓦科斯与上海交响乐团演绎巴托克与霍尔斯特《行星组曲》-2027-03-12-共3张", 2027, 2, 19, 19, 30)

my addTicketReminder("余票处理：波嘉、张昊辰与上海交响乐团演绎普罗科菲耶夫和柴可夫斯基-2027-05-29-共3张", 2027, 5, 8, 19, 30)

return "done"
