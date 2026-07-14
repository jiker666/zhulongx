def find_user(request, database):
    user = request.args["user"]
    query = "SELECT id, name FROM users WHERE name = '" + user + "'"
    return database.execute(query).fetchall()
