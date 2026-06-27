FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server python3 sudo \
  && useradd -m -s /bin/bash rakkr \
  && echo "rakkr:rakkr" | chpasswd \
  && adduser rakkr sudo \
  && printf "rakkr ALL=(ALL) NOPASSWD:ALL\n" > /etc/sudoers.d/rakkr \
  && mkdir -p /run/sshd \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
