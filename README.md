# data-scribbler

- Real-time collaborative data editing. No registration required.
- Supports JSON, JSONPath queries, calculation functions, and three collection types.
- Like spreadsheets, but for hierarchical data.
- Runs in your web browser.

This project powers https://datascribbler.com/

by Jeff Tyrrill -- [email] | [@datascribbler][twitter]

v0.9.0.1

# Server requirements
- Apache
- Python 3
- [fancyBox][fancybox]
- [jQuery][jquery] (tested v2.2.2)
- [bowser]

# Installation instructions

Copy the project files to your `www/` directory. If you already have a `.htaccess` file, then copy the lines from Data Scribbler's into yours.

In `.htaccess`, you may need to edit or remove the following lines depending on how you would like your server to behave. These lines redirect `www.` to no `www.`, and assume your server is running `https`:

```conf
    RewriteCond %{HTTP_HOST} ^www\.(.*)$ [NC]
    RewriteRule ^(.*)$ https://%1/$1 [R=301,L]
```

In your `www/` directory, run these commands:

```sh
chmod o+x main.py
mkdir data
chmod o+w data
```

Obtain copies of [fancyBox][fancybox], [jQuery][jquery], and [bowser], and place them in the `www/` directory. The jQuery and bowser JavaScript files should be directly in the `www/` directory. For fancyBox, there should be a `fancybox` directory in the `www/` directory.

You may want to edit `<div class="prompt prompt-faq"></div>` in `index.html` to include appropriate content for your server.

# Future plans
- The codebase does not currently include functionality to delete old documents. This will come soon.
- Polish based on intial feedback.

# Troubleshooting

If you encounter an access error, make sure you have the `rewrite` Apache mod installed:

```sh
sudo a2enmod rewrite
sudo service apache2 restart
```

If the application doesn't work, check your browser debugger to see if calls to `main.py` are downloading the Python script instead of executing it. If so, check the following:

Make sure that you have the `cgi` Apache mod installed:

```sh
sudo a2enmod cgi
sudo service apache2 restart
```

Make sure that the following (or equivalent) exists in your Apache `.conf` file, within the `<Directory></Directory>` portion:

```conf
Options ExecCGI
AddHandler cgi-script .py
```

Check that `python3` is installed by running `python3` and seeing if you get an interpreter. (Use `exit()` to exit.)

Check the location of `python3` on your machine using:

```sh
whereis python3
```

and make sure that the shebang (the first line) in `main.py` points to one of those locations.

Verify again that `main.py` has the execute permission for the `other` group.

# License

MIT License. See `LICENSE`.

[email]: <mailto:info@datascribbler.com>
[twitter]: <https://twitter.com/datascribbler>
[fancybox]: <http://fancyapps.com/fancybox/>
[jquery]: <https://jquery.com/>
[bowser]: <https://github.com/ded/bowser>
